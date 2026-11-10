import type { RetrievalCall, RetrievalLog } from '../schema';
import { surfaceRetrievalExposure } from '../retrieval';
import { isRecord } from '../lib/type-guards';

// ============================================================================
// Chat-surface retrieval extraction (retrieval-log spec §5.2). Three pure
// functions over the AI SDK `generateText` result of the search-required
// call, each pinned by a captured fixture in __fixtures__/chat/. Inputs are
// typed structurally (unknown + guards) so an SDK type churn shows up as a
// fixture test failure, not a compile error in the runner.
// ============================================================================

type JsonRecord = Record<string, unknown>;

const stringOr = (value: unknown, fallback: string): string => {
  return typeof value === 'string' ? value : fallback;
};

export type RetrievalStep = {
  content: ReadonlyArray<unknown>;
};

const partsOf = (steps: ReadonlyArray<RetrievalStep>): JsonRecord[] => {
  return steps.flatMap((step) => step.content.filter(isRecord));
};

// ---------------------------------------------------------------------------
// ChatGPT (OpenAI Responses `web_search`) — `full`, results incomplete
// ---------------------------------------------------------------------------
// Every `tool-result` part with `toolName === 'web_search'` is one call.
// `output.action.type` maps `search` → search (query), `openPage` →
// open_page, `findInPage` → find_in_page (both carry `url`).
// `output.sources[]` with `type: 'url'` are ONLY the pages the model cited
// from that call, not the whole result list — recorded with
// `resultsComplete: false`, so "not in the sources" never reads as "not in
// the results". A search action may also carry `queries[]` (one tool call
// that ran several searches, verified 2026-09-03): the extra queries are
// recorded as their own search calls with `resultUrls: null`, since the
// sources are not split per query.

export const extractOpenAiRetrieval = (
  steps: ReadonlyArray<RetrievalStep>,
): RetrievalLog => {
  const calls: RetrievalCall[] = [];

  for (const part of partsOf(steps)) {
    if (part.type !== 'tool-result' || part.toolName !== 'web_search') {
      continue;
    }

    const output = isRecord(part.output) ? part.output : {};
    const action = isRecord(output.action) ? output.action : {};
    const sources = Array.isArray(output.sources) ? output.sources : [];
    const sourceUrls = sources.flatMap((source) =>
      isRecord(source) &&
      source.type === 'url' &&
      typeof source.url === 'string'
        ? [source.url]
        : [],
    );

    if (action.type === 'search') {
      const query = stringOr(action.query, '');
      calls.push({
        kind: 'search',
        query,
        url: null,
        resultUrls: sourceUrls,
        resultsComplete: false,
      });

      const extraQueries = Array.isArray(action.queries) ? action.queries : [];

      for (const extra of extraQueries) {
        if (typeof extra !== 'string' || !extra || extra === query) {
          continue;
        }

        calls.push({
          kind: 'search',
          query: extra,
          url: null,
          resultUrls: null,
          resultsComplete: false,
        });
      }
    } else if (action.type === 'openPage' || action.type === 'findInPage') {
      const url = stringOr(action.url, '');
      calls.push({
        kind: action.type === 'openPage' ? 'open_page' : 'find_in_page',
        query: null,
        url,
        // The opened page itself plus whatever the model cited from it.
        resultUrls: [...new Set([...(url ? [url] : []), ...sourceUrls])],
        resultsComplete: false,
      });
    }
  }

  return { exposure: surfaceRetrievalExposure.chatgpt, calls };
};

// ---------------------------------------------------------------------------
// Claude (Anthropic `web_search_20250305`) — `full`
// ---------------------------------------------------------------------------
// `tool-call` parts with `toolName === 'web_search'` carry the query in
// `input.query`; the matching `tool-result` part (by toolCallId) carries
// `output: Array<{ type: 'web_search_result', url, title, pageAge }>`.

export const extractAnthropicRetrieval = (
  steps: ReadonlyArray<RetrievalStep>,
): RetrievalLog => {
  const calls: RetrievalCall[] = [];
  const callIndexById = new Map<string, number>();

  for (const part of partsOf(steps)) {
    if (part.toolName !== 'web_search') {
      continue;
    }

    const input = isRecord(part.input) ? part.input : {};
    const callId = stringOr(part.toolCallId, '');

    if (part.type === 'tool-call') {
      const index =
        calls.push({
          kind: 'search',
          query: stringOr(input.query, ''),
          url: null,
          resultUrls: null,
          resultsComplete: true,
        }) - 1;

      if (callId) {
        callIndexById.set(callId, index);
      }
    } else if (part.type === 'tool-result') {
      let index = callId ? callIndexById.get(callId) : undefined;
      index ??=
        calls.push({
          kind: 'search',
          query: stringOr(input.query, ''),
          url: null,
          resultUrls: null,
          resultsComplete: true,
        }) - 1;

      const call = calls[index];

      if (!call) {
        continue;
      }

      // A non-array output is the provider's error object — results unknown.
      call.resultUrls = Array.isArray(part.output)
        ? part.output.flatMap((item) =>
            isRecord(item) && typeof item.url === 'string' ? [item.url] : [],
          )
        : null;
    }
  }

  return { exposure: surfaceRetrievalExposure.claude, calls };
};

// ---------------------------------------------------------------------------
// The gateway's own search tool (`perplexity_search`) — `full`
// ---------------------------------------------------------------------------
// `tool-call` parts carry the query in `input.query`, a string or a list of
// strings; the matching `tool-result` part (by toolCallId) carries
// `output.results: Array<{ title, url, snippet }>`, every result the tool
// returned. Read from the pinned SDK's declared types (PerplexitySearchInput
// and PerplexitySearchResponse in @ai-sdk/gateway): no real stream has been
// captured yet, because one costs a paid call. A shape that differs yields
// no calls, which the caller stores as "not captured", never as an answer
// from memory.
export const gatewaySearchToolName = 'perplexity_search';

export const extractGatewaySearchRetrieval = (
  steps: ReadonlyArray<RetrievalStep>,
): RetrievalLog => {
  const calls: RetrievalCall[] = [];
  const callIndexById = new Map<string, number>();

  for (const part of partsOf(steps)) {
    if (part.toolName !== gatewaySearchToolName) {
      continue;
    }

    const callId = stringOr(part.toolCallId, '');

    if (part.type === 'tool-call') {
      const input = isRecord(part.input) ? part.input : {};
      const queries = (
        Array.isArray(input.query) ? input.query : [input.query]
      ).filter((query): query is string => typeof query === 'string');

      // One call searched every query, and its results are not split by
      // query: the first carries them, the others say "not known".
      for (const [position, query] of queries.entries()) {
        const index =
          calls.push({
            kind: 'search',
            query,
            url: null,
            resultUrls: null,
            resultsComplete: true,
          }) - 1;

        if (position === 0 && callId) {
          callIndexById.set(callId, index);
        }
      }
    } else if (part.type === 'tool-result') {
      const call = calls[callIndexById.get(callId) ?? -1];
      const output = isRecord(part.output) ? part.output : {};

      // An output without a result list is the tool's error object.
      if (call && Array.isArray(output.results)) {
        call.resultUrls = output.results.flatMap((result) =>
          isRecord(result) && typeof result.url === 'string'
            ? [result.url]
            : [],
        );
      }
    }
  }

  return { exposure: 'full', calls };
};

// ---------------------------------------------------------------------------
// Gemini (Google Search grounding) — `partial`
// ---------------------------------------------------------------------------
// `providerMetadata.<google|vertex>.groundingMetadata.webSearchQueries[]`
// is a flat list of queries for the whole answer (the gateway routes
// gemini-3-flash through Vertex, so the key is `vertex` in practice —
// verified 2026-09-03; both are read). Grounding chunks are not tied to
// individual queries, so every call carries `resultUrls: null`. The chunk
// URIs already sit in the answer's appended source list.

const getGroundingProvider = (meta: JsonRecord): JsonRecord | null => {
  if (isRecord(meta.google)) {
    return meta.google;
  }

  if (isRecord(meta.vertex)) {
    return meta.vertex;
  }

  return null;
};

export const extractGeminiRetrieval = (
  providerMetadata: unknown,
): RetrievalLog => {
  const meta = isRecord(providerMetadata) ? providerMetadata : {};
  const provider = getGroundingProvider(meta);
  const grounding = provider ? provider.groundingMetadata : null;
  const queries = isRecord(grounding) ? grounding.webSearchQueries : null;
  const calls: RetrievalCall[] = (Array.isArray(queries) ? queries : [])
    .filter(
      (query): query is string => typeof query === 'string' && query.length > 0,
    )
    .map((query) => ({
      kind: 'search',
      query,
      url: null,
      resultUrls: null,
      resultsComplete: true,
    }));

  return { exposure: surfaceRetrievalExposure.gemini, calls };
};

/** Every URL in a log's result sets, for redirect resolution. */
export const retrievalResultUrls = (retrieval: RetrievalLog): string[] => {
  return retrieval.calls.flatMap((call) => call.resultUrls ?? []);
};

/**
 * Rewrites result URLs through a resolved-redirect map (grounding-urls.ts),
 * so no google.com wrapper reaches attribution. Returns a new log.
 */
export const rewriteRetrievalUrls = (
  retrieval: RetrievalLog,
  resolved: ReadonlyMap<string, string>,
): RetrievalLog => {
  if (resolved.size === 0) {
    return retrieval;
  }

  return {
    exposure: retrieval.exposure,
    calls: retrieval.calls.map((call) =>
      call.resultUrls
        ? {
            ...call,
            resultUrls: call.resultUrls.map((url) => resolved.get(url) ?? url),
          }
        : call,
    ),
  };
};
