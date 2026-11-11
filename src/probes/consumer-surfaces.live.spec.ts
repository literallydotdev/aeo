import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { requireEnv } from '../lib/env';
import { isRecord } from '../lib/type-guards';
import { resolveDataForSeoLocale } from './dataforseo-locale';

// ============================================================================
// PAID, maintainer-run (.claude/rules/tests-cost-nothing.md): the captures
// the consumer-app adapters are written from (method release spec §5.6).
// No adapter exists yet, so this suite sends the two DataForSEO requests
// itself and keeps each response whole.
//
//  - Google AI Mode: 50 neutral questions, once each. The share that comes
//    back with no answer (task status 40102, or no `ai_overview` item)
//    decides whether the surface ships (§5.3: above 20% it does not).
//  - ChatGPT (the scraped web interface): 6 questions, for the response
//    shape, the model the vendor reports and the `cost` field.
//
// 56 requests at a list price of $0.004 each. The suite stops sending when
// the costs the responses report pass `maxSpendUsd`, or when one response
// reports more than `maxRequestUsd`.
//
// Responses are written to AEO_LIVE_OUTPUT_DIR, outside the repository:
// they name real products, and become fixtures only after a maintainer has
// scrubbed them.
//
//   DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... \
//   AEO_LIVE_OUTPUT_DIR=/path/outside/the/repo \
//     capped npx vitest run --config vitest.live.config.ts \
//     src/probes/consumer-surfaces.live.spec.ts
// ============================================================================

const baseUrl = 'https://api.dataforseo.com/v3';
const chatGptEndpoint = '/ai_optimization/chat_gpt/llm_scraper/live/advanced';
const aiModeEndpoint = '/serp/google/ai_mode/live/advanced';

const maxSpendUsd = 1;
const maxRequestUsd = 0.05;
// DataForSEO documents up to 120 seconds for a live ChatGPT scrape.
const requestTimeoutMs = 150_000;
const concurrency = 5;

const categories = [
  'secure file sharing tools for regulated teams',
  'error tracking tools for web apps',
  'feature flag tools',
  'product analytics platforms',
  'CI/CD platforms',
  'password managers for small teams',
  'managed Postgres hosting providers',
  'help desk tools for customer support',
  'email marketing platforms',
  'log management tools',
] as const;

// Fifty buyer questions naming no company: five ways of asking, about each
// of ten kinds of software.
const buyerQuestions: readonly string[] = categories.flatMap((category) => [
  `What are the best ${category}?`,
  `Which ${category} would you recommend for a startup?`,
  `What should I look for when comparing ${category}?`,
  `Which ${category} are the most affordable?`,
  `What are the most popular ${category} right now?`,
]);

// The question the chat fixtures were captured with, then one buyer
// question of each kind.
const chatGptQuestions: readonly string[] = [
  'What is the current LTS version of Node.js?',
  ...buyerQuestions.slice(0, 5),
];

type Capture = {
  index: number;
  question: string;
  httpStatus: number | null;
  durationMs: number;
  /** null: the request failed before a JSON body was read. */
  body: unknown;
  error: string | null;
};

const numberOr = (value: unknown, fallback: number): number => {
  return typeof value === 'number' ? value : fallback;
};

const firstTask = (body: unknown): Record<string, unknown> | undefined => {
  const tasks: unknown[] =
    isRecord(body) && Array.isArray(body.tasks) ? body.tasks : [];
  const [task] = tasks;

  return isRecord(task) ? task : undefined;
};

const firstResult = (body: unknown): Record<string, unknown> | undefined => {
  const task = firstTask(body);
  const results: unknown[] =
    task && Array.isArray(task.result) ? task.result : [];
  const [result] = results;

  return isRecord(result) ? result : undefined;
};

const lengthOf = (value: unknown): number | null => {
  return Array.isArray(value) || typeof value === 'string'
    ? value.length
    : null;
};

describe('consumer-app surfaces (live, paid)', () => {
  let authorization: string;
  let outputDir: string;
  let spentUsd = 0;
  let stopped: string | undefined;

  const locale = resolveDataForSeoLocale('US', 'en');

  beforeAll(() => {
    const login = requireEnv('DATAFORSEO_LOGIN');
    const password = requireEnv('DATAFORSEO_PASSWORD');

    authorization = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
    outputDir = path.resolve(
      requireEnv(
        'AEO_LIVE_OUTPUT_DIR',
        'Please set AEO_LIVE_OUTPUT_DIR to a directory outside the repository; the captures are written there.',
      ),
    );

    const repository = path.resolve(import.meta.dirname, '..', '..');

    if (!path.relative(repository, outputDir).startsWith('..')) {
      throw new Error(
        `AEO_LIVE_OUTPUT_DIR is inside the repository (${outputDir}). A raw capture is not fit to commit; name a directory outside it.`,
      );
    }
  });

  /** One paid request, or none once the suite has stopped spending. */
  const capture = async (
    endpoint: string,
    task: Record<string, unknown>,
    { index, question }: { index: number; question: string },
  ): Promise<Capture | undefined> => {
    if (stopped) {
      return undefined;
    }

    const startedAt = Date.now();
    const settled = (fields: Partial<Capture>): Capture => {
      return {
        index,
        question,
        httpStatus: null,
        durationMs: Date.now() - startedAt,
        body: null,
        error: null,
        ...fields,
      };
    };

    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([task]),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const text = await response.text();
      let body: unknown = null;

      try {
        body = JSON.parse(text);
      } catch {
        return settled({
          httpStatus: response.status,
          error: `not JSON: ${text.slice(0, 200)}`,
        });
      }

      const costUsd = numberOr(isRecord(body) ? body.cost : undefined, 0);

      spentUsd += costUsd;

      if (costUsd > maxRequestUsd) {
        stopped ??= `one response reported $${costUsd}, above $${maxRequestUsd}`;
      } else if (spentUsd > maxSpendUsd) {
        stopped ??= `the responses reported $${spentUsd.toFixed(3)} in all, above $${maxSpendUsd}`;
      }

      return settled({ httpStatus: response.status, body });
    } catch (error) {
      return settled({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Every question through `ask`, a few at a time, each response written
   * as it arrives. */
  const captureAll = async (
    name: string,
    questions: readonly string[],
    ask: (question: string, index: number) => Promise<Capture | undefined>,
  ): Promise<Capture[]> => {
    const directory = path.join(outputDir, name);
    const captures: Capture[] = [];
    let next = 0;

    mkdirSync(directory, { recursive: true });

    const worker = async (): Promise<void> => {
      for (let index = next++; index < questions.length; index = next++) {
        const question = questions[index];
        const captured =
          question === undefined ? undefined : await ask(question, index);

        if (!captured) {
          continue;
        }

        captures.push(captured);
        writeFileSync(
          path.join(directory, `${String(index).padStart(2, '0')}.json`),
          `${JSON.stringify(captured, null, 2)}\n`,
        );
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    return captures.sort((a, b) => a.index - b.index);
  };

  const writeSummary = (name: string, summary: unknown): void => {
    writeFileSync(
      path.join(outputDir, name, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  };

  it(
    'should capture Google AI Mode on fifty neutral questions and count the answers that are missing',
    async () => {
      expect(locale).toBeDefined();

      const captures = await captureAll(
        'ai-mode',
        buyerQuestions,
        (question, index) =>
          capture(
            aiModeEndpoint,
            {
              keyword: question,
              location_code: locale?.locationCode,
              language_code: locale?.languageCode,
            },
            { index, question },
          ),
      );
      const rows = captures.map(
        ({ index, question, httpStatus, durationMs, body, error }) => {
          const task = firstTask(body);
          const result = firstResult(body);
          const items =
            result && Array.isArray(result.items) ? result.items : [];
          const overview = items.find(
            (item): item is Record<string, unknown> =>
              isRecord(item) && item.type === 'ai_overview',
          );

          return {
            index,
            question,
            httpStatus,
            durationMs,
            error,
            statusCode: isRecord(body) ? body.status_code : null,
            taskStatusCode: task?.status_code ?? null,
            taskStatusMessage: task?.status_message ?? null,
            costUsd: isRecord(body) ? (body.cost ?? null) : null,
            taskCostUsd: task?.cost ?? null,
            itemTypes: result?.item_types ?? null,
            hasOverview: overview !== undefined,
            markdownChars: lengthOf(overview?.markdown),
            references: lengthOf(overview?.references),
          };
        },
      );
      const answered = rows.filter(
        (row) => row.hasOverview && (row.markdownChars ?? 0) > 0,
      ).length;
      const byTaskStatus: Record<string, number> = {};

      for (const row of rows) {
        const key =
          typeof row.taskStatusCode === 'number'
            ? String(row.taskStatusCode)
            : (row.error ?? 'no task');

        byTaskStatus[key] = (byTaskStatus[key] ?? 0) + 1;
      }

      writeSummary('ai-mode', {
        requests: rows.length,
        planned: buyerQuestions.length,
        answered,
        missing: rows.length - answered,
        missingShare:
          rows.length === 0 ? null : (rows.length - answered) / rows.length,
        byTaskStatus,
        spentUsd,
        stopped: stopped ?? null,
        rows,
      });

      // A measurement, not a verdict: the suite fails only when it could
      // not take it.
      expect(stopped).toBeUndefined();
      expect(rows).toHaveLength(buyerQuestions.length);
    },
    40 * 60_000,
  );

  it(
    "should capture ChatGPT's web interface with the model the vendor reports and its sources",
    async () => {
      expect(locale).toBeDefined();

      const captures = await captureAll(
        'chatgpt-app',
        chatGptQuestions,
        (question, index) =>
          capture(
            chatGptEndpoint,
            {
              keyword: question,
              location_code: locale?.locationCode,
              language_code: locale?.languageCode,
              force_web_search: true,
            },
            { index, question },
          ),
      );
      const rows = captures.map(
        ({ index, question, httpStatus, durationMs, body, error }) => {
          const task = firstTask(body);
          const result = firstResult(body);

          return {
            index,
            question,
            httpStatus,
            durationMs,
            error,
            statusCode: isRecord(body) ? body.status_code : null,
            taskStatusCode: task?.status_code ?? null,
            taskStatusMessage: task?.status_message ?? null,
            costUsd: isRecord(body) ? (body.cost ?? null) : null,
            taskCostUsd: task?.cost ?? null,
            model: result?.model ?? null,
            itemTypes: result?.item_types ?? null,
            markdownChars: lengthOf(result?.markdown),
            sources: lengthOf(result?.sources),
            searchResults: lengthOf(result?.search_results),
            fanOutQueries: lengthOf(result?.fan_out_queries),
          };
        },
      );

      writeSummary('chatgpt-app', {
        requests: rows.length,
        planned: chatGptQuestions.length,
        spentUsd,
        stopped: stopped ?? null,
        rows,
      });

      expect(stopped).toBeUndefined();
      expect(rows).toHaveLength(chatGptQuestions.length);
    },
    20 * 60_000,
  );
});
