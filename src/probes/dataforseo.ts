import { z } from 'zod';
import { createLog } from '../lib/log';
import { readEnv } from '../lib/env';
import {
  dataForSeoLanguageCodes,
  dataForSeoLocationCodes,
} from './dataforseo-locale';
import { ProbeFailure } from './failure';

const log = createLog('DataForSEO');

// ============================================================================
// DataForSEO client — Google AI Overview slice only (ported from the
// console's intelligence/clients/dataforseo.ts; the SERP/keyword endpoints
// this audit doesn't use were left behind).
//
// Failure taxonomy (hardening spec §2.2, §3.6): a SERP that came back with
// no `ai_overview` item is an honest measurement (`no_overview`); a failed
// task, a bad location code, a 5xx or a timeout is a typed ProbeFailure
// that follows the probe retry policy — never a captured "no AI Overview".
// Retries belong to the caller: each attempt here is one paid SERP task.
// ============================================================================

// The envelope is read leniently: only the fields the client branches on are
// checked, and a missing message prints as before.
const dataForSeoResponseSchema = z.object({
  status_code: z.number(),
  status_message: z.string().optional(),
  tasks: z
    .array(
      z.object({
        id: z.string().optional(),
        status_code: z.number(),
        status_message: z.string().optional(),
        result: z.array(z.unknown()).nullish(),
      }),
    )
    .nullish(),
});

const serpResultSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).nullish(),
});

const aiOverviewItemSchema = z.object({
  markdown: z.string().nullish(),
  references: z
    .array(
      z.object({
        source: z.string().nullish(),
        domain: z.string().nullish(),
        url: z.string().nullish(),
        title: z.string().nullish(),
        text: z.string().nullish(),
      }),
    )
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

const baseUrl = 'https://api.dataforseo.com/v3';
const requestDelayMs = 50;
const requestTimeoutMs = 30_000;

// Serialized throttle: callers queue behind one chain instead of all
// reading the last request time before any of them awaits (§3.5).
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

const getAuthHeader = (): string => {
  const login = readEnv('DATAFORSEO_LOGIN');
  const password = readEnv('DATAFORSEO_PASSWORD');

  if (!login || !password) {
    throw new ProbeFailure('auth', 'DataForSEO credentials not configured');
  }

  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
};

// DataForSEO's own status codes: 40202 is "too many requests".
const capacityStatusCodes = new Set([40202]);

const apiRequest = async (
  endpoint: string,
  body: unknown[],
): Promise<unknown[]> => {
  const authorization = getAuthHeader();

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

    const data = dataForSeoResponseSchema.parse(await response.json());

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

export const getGoogleAIOverview = async (
  query: string,
  geography: string,
  language: string,
): Promise<AIOverviewOutcome> => {
  const tasks = [
    {
      keyword: query,
      ...getGeoParams(geography, language),
      load_async_ai_overview: true,
    },
  ];

  const results = await apiRequest('/serp/google/organic/live/advanced', tasks);

  if (results.length === 0) {
    throw new ProbeFailure(
      'cli_error',
      'DataForSEO returned a completed task with no SERP result.',
    );
  }

  for (const result of results) {
    const items = serpResultSchema.parse(result).items ?? [];
    const aiOverviewItem = items.find((item) => item.type === 'ai_overview');

    if (!aiOverviewItem) {
      continue;
    }

    const aiOverview = aiOverviewItemSchema.parse(aiOverviewItem);
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

// ---------------------------------------------------------------------------
// Geo helpers (ported subset — SERP live endpoints require a location code)
// ---------------------------------------------------------------------------

const getLocationCode = (geography: string): number => {
  return dataForSeoLocationCodes[geography.toLowerCase()] ?? 2840;
};

const getGeoParams = (
  geography: string,
  language: string,
): Record<string, number | string> => {
  return {
    language_code: getLanguageCode(language),
    location_code: getLocationCode(geography),
  };
};

const getLanguageCode = (language: string): string => {
  return dataForSeoLanguageCodes[language.toLowerCase()] ?? 'en';
};
