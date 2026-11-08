import { z } from 'zod';
import { createLog } from '../lib/log';
import type { resolveDataForSeoLocale } from './dataforseo-locale';
import { ProbeFailure } from './failure';

const log = createLog('DataForSEO');

// ============================================================================
// DataForSEO client — Google AI Overview slice only (ported from the
// console's intelligence/clients/dataforseo.ts; the SERP/keyword endpoints
// this audit doesn't use were left behind).
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
// ============================================================================

// Provider fields the client does not read pass through unchecked, so a
// field DataForSEO adds never fails a probe; every field it reads is typed
// and bounded.
const dataForSeoResponseSchema = z.object({
  status_code: z.number(),
  status_message: z.string().max(2_000).optional(),
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

/** Where a SERP is placed: a market resolveDataForSeoLocale mapped. */
export type DataForSeoLocale = NonNullable<
  ReturnType<typeof resolveDataForSeoLocale>
>;

export type DataForSeoProbeClient = {
  getGoogleAIOverview: (
    query: string,
    locale: DataForSeoLocale,
  ) => Promise<AIOverviewOutcome>;
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
const requestDelayMs = 50;
const requestTimeoutMs = 30_000;
const maxResponseBytes = 8 * 1024 * 1024;

// DataForSEO's own status codes: 40202 is "too many requests".
const capacityStatusCodes = new Set([40202]);

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

/**
 * createDataForSeoProbeClient is one run's AI Overview client. Requests are
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
  ): Promise<unknown[]> => {
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
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';

        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new ProbeFailure(
            'timeout',
            `DataForSEO request exceeded ${requestTimeoutMs}ms`,
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
        if (task.status_code === 20000 && task.result) {
          results.push(...task.result);
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
          capacityStatusCodes.has(task.status_code) ? 'capacity' : 'cli_error',
          `DataForSEO task ${task.status_code}: ${task.status_message}`,
        );
      }

      return results;
    });
  };

  const getGoogleAIOverview: DataForSeoProbeClient['getGoogleAIOverview'] =
    async (query, locale) => {
      const results = await apiRequest(aiOverviewEndpoint, [
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
        const markdown = aiOverview.markdown ?? '';
        const rawRefs = aiOverview.references ?? [];

        return {
          status: 'overview',
          markdown,
          references: rawRefs.map((ref) => ({
            source: ref.source ?? '',
            domain: ref.domain ?? '',
            url: ref.url ?? '',
            title: ref.title ?? '',
            text: ref.text ?? '',
          })),
        };
      }

      return { status: 'no_overview' };
    };

  return { getGoogleAIOverview };
};
