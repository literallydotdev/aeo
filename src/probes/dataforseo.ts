import { z } from 'zod';
import { createLog } from '../lib/log';
import type { resolveDataForSeoLocale } from './dataforseo-locale';
import { ProbeFailure, type ProbeFailureKind } from './failure';

const log = createLog('DataForSEO');

// ============================================================================
// DataForSEO client: the three endpoints the probes ask. Google AI Overview
// (ported from the console's intelligence/clients/dataforseo.ts; the
// SERP/keyword endpoints this audit doesn't use were left behind), and the
// two consumer-app scrapes of the method release spec §5: Google AI Mode
// and ChatGPT's web interface.
//
// One client per run (probe adapters spec §7, phase 3 item 5): its
// credentials are passed in, its throttle is its own, its response body is
// bounded while it is read, and every field it reads is checked. The market
// is a resolved DataForSEO locale; a market the table cannot place is refused
// when the run is planned, never sent as the United States.
//
// Failure taxonomy (hardening spec §2.2, §3.6): a SERP that came back with
// no `ai_overview` item is an honest measurement (`no_overview`); a failed
// task, a bad location code, a 5xx or a timeout is a typed ProbeFailure
// that follows the probe retry policy — never a captured "no AI Overview".
// Retries belong to the caller: each attempt here is one paid SERP task.
//
// The consumer-app response shapes are pinned by the captures in
// __fixtures__/dataforseo (11 November 2026).
// ============================================================================

// Provider fields the client does not read pass through unchecked, so a
// field DataForSEO adds never fails a probe; every field it reads is typed
// and bounded.
const dataForSeoResponseSchema = z.object({
  status_code: z.number(),
  status_message: z.string().max(2_000).optional(),
  // What the whole response was billed, in USD; read by reportedCostOf.
  cost: z.unknown().optional(),
  tasks: z
    .array(
      z.object({
        id: z.string().max(200).optional(),
        status_code: z.number(),
        status_message: z.string().max(2_000).optional(),
        result: z.array(z.unknown()).max(100).nullish(),
      }),
    )
    .max(100)
    .nullish(),
});

const serpResultSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).max(1_000).nullish(),
});

const referenceField = z.string().max(10_000).nullish();

const aiOverviewItemSchema = z.object({
  markdown: z.string().max(200_000).nullish(),
  references: z
    .array(
      z.object({
        source: referenceField,
        domain: referenceField,
        url: referenceField,
        title: referenceField,
        text: referenceField,
      }),
    )
    .max(500)
    .nullish(),
});

export type AIOverviewReference = {
  source: string;
  domain: string;
  url: string;
  title: string;
  text: string;
};

export type AIOverviewOutcome =
  | { status: 'overview'; markdown: string; references: AIOverviewReference[] }
  | { status: 'no_overview' };

// The parts of a scraped ChatGPT answer that are the answer: its prose and
// its tables. Every other item (image carousels, whose markdown is an
// embed of a thumbnail under the page title it was found on, and the
// shopping, ad and local-business items) is left out: none is the
// assistant's words or a source it cites.
const chatGptAnswerItemTypes: ReadonlySet<string> = new Set([
  'chat_gpt_text',
  'chat_gpt_table',
]);

const chatGptResultSchema = z.object({
  // The model the scraper read off the page; nothing pins it.
  model: z.string().max(200).nullish(),
  items: z
    .array(
      z.object({
        type: z.string().max(100),
        markdown: z.string().max(200_000).nullish(),
      }),
    )
    .max(1_000)
    .nullish(),
  sources: z
    .array(z.object({ url: referenceField, title: referenceField }))
    .max(500)
    .nullish(),
  fan_out_queries: z.array(z.string().max(2_000)).max(200).nullish(),
});

/** What a paid response reported as its cost; null when it reported none. */
type ReportedCost = { costUsd: number | null };

export type AiModeAnswer = ReportedCost & {
  markdown: string;
  references: AIOverviewReference[];
};

export type ChatGptAppSource = { url: string; title: string };

export type ChatGptAppAnswer = ReportedCost & {
  /** The answer's prose and tables, in the order the page shows them. */
  markdown: string;
  /** The sources the vendor describes as cited or relied on. */
  sources: ChatGptAppSource[];
  /** The searches the answer ran, as a flat list; null when the response
   * reported no list. */
  fanOutQueries: string[] | null;
  /** The model the scraper reports, verbatim; null when it names none. */
  model: string | null;
};

/** Where a SERP is placed: a market resolveDataForSeoLocale mapped. */
export type DataForSeoLocale = NonNullable<
  ReturnType<typeof resolveDataForSeoLocale>
>;

export type DataForSeoProbeClient = {
  getGoogleAIOverview: (
    query: string,
    locale: DataForSeoLocale,
  ) => Promise<AIOverviewOutcome>;
  getGoogleAiMode: (
    query: string,
    locale: DataForSeoLocale,
  ) => Promise<AiModeAnswer>;
  getChatGptAnswer: (
    query: string,
    locale: DataForSeoLocale,
  ) => Promise<ChatGptAppAnswer>;
};

const baseUrl = 'https://api.dataforseo.com/v3';
export const aiOverviewEndpoint = '/serp/google/organic/live/advanced';

/** aiOverviewTask is the SERP task an AI Overview probe sends. */
export const aiOverviewTask = (query: string, locale: DataForSeoLocale) => {
  return {
    keyword: query,
    language_code: locale.languageCode,
    location_code: locale.locationCode,
    load_async_ai_overview: true,
  };
};

export const aiModeEndpoint = '/serp/google/ai_mode/live/advanced';

/** aiModeTask is the task an AI Mode probe sends. */
export const aiModeTask = (query: string, locale: DataForSeoLocale) => {
  return {
    keyword: query,
    language_code: locale.languageCode,
    location_code: locale.locationCode,
  };
};

export const chatGptEndpoint =
  '/ai_optimization/chat_gpt/llm_scraper/live/advanced';

/** chatGptTask is the task a ChatGPT probe sends: the web interface, with
 * its search forced on, as every other surface is asked. */
export const chatGptTask = (query: string, locale: DataForSeoLocale) => {
  return {
    keyword: query,
    language_code: locale.languageCode,
    location_code: locale.locationCode,
    force_web_search: true,
  };
};

const requestDelayMs = 50;
const requestTimeoutMs = 30_000;
// AI Mode answered in 9 seconds at the median and 19 at most over 50
// requests (11 November 2026).
const aiModeTimeoutMs = 60_000;
// DataForSEO documents up to 120 seconds for a live ChatGPT scrape; six
// took 13 to 61 (11 November 2026).
const chatGptTimeoutMs = 150_000;
const maxResponseBytes = 8 * 1024 * 1024;

// DataForSEO's own status codes: 40202 is "too many requests".
const capacityStatusCodes = new Set([40202]);
// 40102 is "No Search Results". AI Mode always answers in the product, so
// on that endpoint it is a scrape that came back without its answer
// (method release spec §5.3), not an absence to record.
const noResultsStatusCode = 40102;

type ApiRequestOptions = {
  timeoutMs?: number;
  /** Status codes that mean the surface returned no answer. */
  emptyAnswerStatusCodes?: ReadonlySet<number>;
};

type ApiResponse = { results: unknown[]; costUsd: number | null };

/** readBoundedBody reads a response body, refusing one larger than the
 * limit as it arrives instead of after buffering it whole. */
const readBoundedBody = async (response: Response): Promise<string> => {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    ) {
      size += chunk.value.length;

      if (size > maxResponseBytes) {
        throw new ProbeFailure(
          'cli_error',
          `DataForSEO response exceeds ${maxResponseBytes} bytes`,
        );
      }

      chunks.push(chunk.value);
    }
  } finally {
    // Cancelling a finished or failed reader has nothing left to report.
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks).toString('utf8');
};

/** parseProviderJson checks a provider document against `schema`, and
 * reports a document that is not the shape the client reads as a parser
 * failure of the probe. */
const parseProviderJson = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    throw new ProbeFailure(
      'parser',
      `DataForSEO response does not match the expected shape (${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'})`,
    );
  }

  return parsed.data;
};

/** The cost a response reported, or null: a value that is not an amount
 * is a cost that was not reported, never a reason to lose a paid answer. */
const reportedCostOf = (cost: unknown): number | null => {
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
    ? cost
    : null;
};

const taskFailureKind = (
  statusCode: number,
  emptyAnswerStatusCodes: ReadonlySet<number>,
): ProbeFailureKind => {
  if (emptyAnswerStatusCodes.has(statusCode)) {
    return 'empty_answer';
  }

  return capacityStatusCodes.has(statusCode) ? 'capacity' : 'cli_error';
};

/** The markdown and references of an `ai_overview` item, as the client
 * hands them on: an absent field is an empty one. */
const aiOverviewContent = (
  item: z.infer<typeof aiOverviewItemSchema>,
): { markdown: string; references: AIOverviewReference[] } => {
  return {
    markdown: item.markdown ?? '',
    references: (item.references ?? []).map((reference) => ({
      source: reference.source ?? '',
      domain: reference.domain ?? '',
      url: reference.url ?? '',
      title: reference.title ?? '',
      text: reference.text ?? '',
    })),
  };
};

/**
 * createDataForSeoProbeClient is one run's DataForSEO client. Requests are
 * spaced by the client's own throttle: callers queue behind one chain
 * instead of all reading the last request time before any of them awaits
 * (§3.5).
 */
export const createDataForSeoProbeClient = ({
  login,
  password,
}: {
  login: string;
  password: string;
}): DataForSeoProbeClient => {
  if (!login || !password) {
    throw new Error('Please provide both DataForSEO credentials.');
  }

  const authorization = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
  let throttleChain: Promise<void> = Promise.resolve();

  const throttled = <T>(fn: () => Promise<T>): Promise<T> => {
    const slot = throttleChain.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, requestDelayMs);
        }),
    );

    throttleChain = slot.catch(() => undefined);

    return slot.then(fn);
  };

  const apiRequest = async (
    endpoint: string,
    body: unknown[],
    {
      timeoutMs = requestTimeoutMs,
      emptyAnswerStatusCodes = new Set(),
    }: ApiRequestOptions = {},
  ): Promise<ApiResponse> => {
    return throttled(async () => {
      let response: Response;

      try {
        response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            'Authorization': authorization,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';

        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new ProbeFailure(
            'timeout',
            `DataForSEO request exceeded ${timeoutMs}ms`,
            { cause: error },
          );
        }

        throw new ProbeFailure(
          'cli_error',
          `DataForSEO request failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const detail = `${response.status}: ${response.statusText}`;

        if (response.status === 401 || response.status === 403) {
          throw new ProbeFailure(
            'auth',
            `DataForSEO rejected the credentials (${detail})`,
          );
        }

        if (response.status === 429 || response.status === 503) {
          throw new ProbeFailure(
            'capacity',
            `DataForSEO is throttling (${detail})`,
          );
        }

        throw new ProbeFailure('cli_error', `DataForSEO HTTP error ${detail}`);
      }

      const text = await readBoundedBody(response);
      let json: unknown;

      try {
        json = JSON.parse(text);
      } catch (error) {
        throw new ProbeFailure('parser', 'DataForSEO response is not JSON', {
          cause: error,
        });
      }

      const data = parseProviderJson(dataForSeoResponseSchema, json);

      if (data.status_code !== 20000) {
        if (emptyAnswerStatusCodes.has(data.status_code)) {
          throw new ProbeFailure(
            'empty_answer',
            `DataForSEO API ${data.status_code}: ${data.status_message}`,
          );
        }

        if (capacityStatusCodes.has(data.status_code)) {
          throw new ProbeFailure(
            'capacity',
            `DataForSEO API ${data.status_code}: ${data.status_message}`,
          );
        }

        // 40101 is a search-engine server error, not rejected credentials.
        // https://docs.dataforseo.com/v3/appendix/errors/
        if (data.status_code === 40100) {
          throw new ProbeFailure(
            'auth',
            `DataForSEO API ${data.status_code}: ${data.status_message}`,
          );
        }

        throw new ProbeFailure(
          'cli_error',
          `DataForSEO API ${data.status_code}: ${data.status_message}`,
        );
      }

      const results: unknown[] = [];

      for (const task of data.tasks ?? []) {
        // A completed task without a result has nothing to hand on; each
        // caller says what an empty result means on its endpoint.
        if (task.status_code === 20000) {
          results.push(...(task.result ?? []));
          continue;
        }

        // A task that did not complete is a failed probe, not an absent
        // AI Overview (§2.2).
        log.warn('DataForSEO task failed', {
          endpoint,
          taskId: task.id,
          taskStatusCode: task.status_code,
          taskStatusMessage: task.status_message,
        });

        throw new ProbeFailure(
          taskFailureKind(task.status_code, emptyAnswerStatusCodes),
          `DataForSEO task ${task.status_code}: ${task.status_message}`,
        );
      }

      return { results, costUsd: reportedCostOf(data.cost) };
    });
  };

  const getGoogleAIOverview: DataForSeoProbeClient['getGoogleAIOverview'] =
    async (query, locale) => {
      const { results } = await apiRequest(aiOverviewEndpoint, [
        aiOverviewTask(query, locale),
      ]);

      if (results.length === 0) {
        throw new ProbeFailure(
          'cli_error',
          'DataForSEO returned a completed task with no SERP result.',
        );
      }

      for (const result of results) {
        const items = parseProviderJson(serpResultSchema, result).items ?? [];
        const aiOverviewItem = items.find(
          (item) => item.type === 'ai_overview',
        );

        if (!aiOverviewItem) {
          continue;
        }

        const aiOverview = parseProviderJson(
          aiOverviewItemSchema,
          aiOverviewItem,
        );
        return { status: 'overview', ...aiOverviewContent(aiOverview) };
      }

      return { status: 'no_overview' };
    };

  const getGoogleAiMode: DataForSeoProbeClient['getGoogleAiMode'] = async (
    query,
    locale,
  ) => {
    const { results, costUsd } = await apiRequest(
      aiModeEndpoint,
      [aiModeTask(query, locale)],
      {
        timeoutMs: aiModeTimeoutMs,
        emptyAnswerStatusCodes: new Set([noResultsStatusCode]),
      },
    );

    // The endpoint returns the answer as the one `ai_overview` item of
    // its result.
    for (const result of results) {
      const items = parseProviderJson(serpResultSchema, result).items ?? [];
      const answerItem = items.find((item) => item.type === 'ai_overview');

      if (answerItem) {
        return {
          ...aiOverviewContent(
            parseProviderJson(aiOverviewItemSchema, answerItem),
          ),
          costUsd,
        };
      }
    }

    throw new ProbeFailure(
      'empty_answer',
      'DataForSEO returned an AI Mode result without its answer.',
    );
  };

  const getChatGptAnswer: DataForSeoProbeClient['getChatGptAnswer'] = async (
    query,
    locale,
  ) => {
    const { results, costUsd } = await apiRequest(
      chatGptEndpoint,
      [chatGptTask(query, locale)],
      { timeoutMs: chatGptTimeoutMs },
    );
    const [first] = results;

    if (first === undefined) {
      throw new ProbeFailure(
        'empty_answer',
        'DataForSEO returned a completed ChatGPT task with no result.',
      );
    }

    const result = parseProviderJson(chatGptResultSchema, first);
    const markdown = (result.items ?? [])
      .filter((item) => chatGptAnswerItemTypes.has(item.type))
      .map((item) => (item.markdown ?? '').trim())
      .filter((part) => part !== '')
      .join('\n\n');

    return {
      markdown,
      sources: (result.sources ?? []).flatMap((source) =>
        source.url ? [{ url: source.url, title: source.title ?? '' }] : [],
      ),
      fanOutQueries:
        result.fan_out_queries?.filter((fanOutQuery) => fanOutQuery !== '') ??
        null,
      model: result.model ?? null,
      costUsd,
    };
  };

  return { getGoogleAIOverview, getGoogleAiMode, getChatGptAnswer };
};
