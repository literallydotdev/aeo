import type { AeoAgentSurface } from '../surfaces';
import type { RetrievalCall, RetrievalLog } from '../schema';
import { surfaceRetrievalExposure } from '../retrieval';
import { createLog } from '../lib/log';
import { isRecord } from '../lib/type-guards';

const log = createLog('AgentCliParsers');

// ============================================================================
// Agent CLI stream parsers (correctness spec §3.1, retrieval-log spec §5.1).
// Pure functions over the raw stdout of a headless CLI run — no process
// handling here, so the fixture tests in agent-cli-parsers.spec.ts pin every
// CLI's event shape.
// ============================================================================
// One definition of `usedWebSearch`, uniform across the three CLIs:
//   true  — at least one web search or web fetch tool call COMPLETED
//           successfully in the event stream.
//   false — the stream was parsed and no web tool call was attempted; the
//           answer came from model priors (honest data).
//   null  — the CLI produced an answer but its stream could not be parsed
//           for tool calls (a torn line where a tool event may have been,
//           or no per-turn events at all). Never guessed from answer text.
// A web tool call that was attempted and rejected or denied is neither: the
// surface is misconfigured on the runner, so the probe throws
// RejectedWebToolError and counts as a failed probe after retry (§3.6).
//
// Alongside the flag, every parser records the retrieval log: each web call
// in stream order with its query or target URL and, where the CLI exposes
// it, the URLs it returned. A call whose result never arrives or errors is
// kept with `resultUrls: null`. The flag and the log must agree
// (assertRetrievalConsistency) — a mismatch is a parser bug and fails the
// probe rather than reaching the page.

export type ParsedAgentStream = {
  text: string;
  usedWebSearch: boolean | null;
  retrieval: RetrievalLog;
  // The model the API reported on the CLI's own response events, when the
  // stream carries one. Claude Code does (`message.model`); Cursor names only
  // its selector ("Auto") and Codex names none.
  reportedModel?: string;
};

/** A web tool call the CLI refused — a runner configuration problem. */
export class RejectedWebToolError extends Error {
  readonly surface: AeoAgentSurface;
  readonly tool: string;

  constructor(surface: AeoAgentSurface, tool: string, detail: string) {
    super(`${surface} rejected web tool ${tool}: ${detail}`);
    this.surface = surface;
    this.tool = tool;
    this.name = 'RejectedWebToolError';
  }
}

/**
 * The stream could not be read as an answer. `cli_error`: the CLI itself
 * reported failure (an error result event, no agent message); `parser`:
 * the stream shape did not match what the parser expects (a torn line
 * where the result should be, a result without text) — a runner bug or a
 * CLI format change, retried once at most (hardening spec §4.6).
 */
export class AgentStreamError extends Error {
  readonly kind: 'cli_error' | 'parser';

  constructor(kind: 'cli_error' | 'parser', message: string) {
    super(message);
    this.kind = kind;
    this.name = 'AgentStreamError';
  }
}

/** The web-tool flag and the retrieval log disagree — a parser bug. */
export class RetrievalConsistencyError extends Error {
  readonly surface: AeoAgentSurface;

  constructor(surface: AeoAgentSurface, detail: string) {
    super(
      `${surface} retrieval log inconsistent with usedWebSearch: ${detail}`,
    );

    this.surface = surface;
    this.name = 'RetrievalConsistencyError';
  }
}

/**
 * Runner invariant (retrieval-log spec §7): `usedWebSearch === true` implies
 * at least one call in the log (every kind is a web call: a Codex
 * open-page action counts as much as a search); `false` implies no calls at
 * all (every agent surface exposes at least its queries). `null` — unknown
 * retrieval — asserts nothing.
 */
export const assertRetrievalConsistency = (
  surface: AeoAgentSurface,
  usedWebSearch: boolean | null,
  retrieval: RetrievalLog,
): void => {
  if (usedWebSearch === true && retrieval.calls.length === 0) {
    throw new RetrievalConsistencyError(
      surface,
      'a web tool call completed but the log holds no call',
    );
  }

  if (usedWebSearch === false && retrieval.calls.length > 0) {
    throw new RetrievalConsistencyError(
      surface,
      `no web tool call was attempted but the log holds ${retrieval.calls.length} call(s)`,
    );
  }
};

type JsonRecord = Record<string, unknown>;

const stringOr = (value: unknown, fallback: string): string => {
  return typeof value === 'string' ? value : fallback;
};

const searchCall = (query: string): RetrievalCall => {
  return {
    kind: 'search',
    query,
    url: null,
    resultUrls: null,
    resultsComplete: true,
  };
};

const fetchCall = (url: string): RetrievalCall => {
  return {
    kind: 'fetch',
    query: null,
    url,
    resultUrls: null,
    resultsComplete: true,
  };
};

// NDJSON parse: one JSON object per line; blank lines are skipped. `torn`
// counts every non-empty line that is not a JSON object — an interrupted
// write, or a warning a CLI prefixed to a JSON line (hardening spec §2.10).
// A torn line may have held a tool event, so a parse that would otherwise
// conclude `false` degrades to `null` instead. Lines are length-bounded
// before any regex or JSON work touches them.
const maxLineChars = 4 * 1024 * 1024;

const parseNdjson = (
  stdout: string,
): { events: JsonRecord[]; torn: number } => {
  const events: JsonRecord[] = [];
  let torn = 0;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    if (!trimmed.startsWith('{') || trimmed.length > maxLineChars) {
      torn += 1;
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);

      if (isRecord(parsed)) {
        events.push(parsed);
      } else {
        torn += 1;
      }
    } catch {
      torn += 1;
    }
  }

  return { events, torn };
};

// A web call that was attempted but never completed successfully (a network
// error inside the tool, a call still open when the stream ended) is not a
// from-memory answer and not a completed search: retrieval is unknown.
const resolveFlag = ({
  attempted,
  succeeded,
  parsedTurnEvents,
  torn,
}: {
  attempted: boolean;
  succeeded: boolean;
  parsedTurnEvents: boolean;
  torn: number;
}): boolean | null => {
  if (succeeded) {
    return true;
  }

  if (attempted) {
    return null;
  }

  if (!parsedTurnEvents || torn > 0) {
    return null;
  }

  return false;
};

const getCursorRefusalDetail = (outcome: JsonRecord): JsonRecord => {
  if (isRecord(outcome.rejected)) {
    return outcome.rejected;
  }

  if (isRecord(outcome.permissionDenied)) {
    return outcome.permissionDenied;
  }

  return {};
};

const getCursorRefusalSuffix = (outcome: JsonRecord): string => {
  const detail = getCursorRefusalDetail(outcome);

  if (typeof detail.reason === 'string') {
    return ` (${detail.reason})`;
  }

  if (typeof detail.error === 'string') {
    return ` (${detail.error})`;
  }

  return '';
};

// ---------------------------------------------------------------------------
// Claude Code — `claude -p --output-format stream-json --verbose`
// ---------------------------------------------------------------------------
// `assistant` events carry `message.content[]`; a tool call is
// `{ type: 'tool_use', name, input }`. Only exact names count: the CLI also
// emits `ToolSearch` (a deferred-tool loader that runs BEFORE WebSearch and
// counts as a turn), which must not. `user` events carry the matching
// `tool_result` blocks; a web tool result with `is_error: true` is not a
// completed search. The final `result` event carries the answer and
// `permission_denials` — a denied WebSearch/WebFetch is the rejected-tool
// failure (the class the old `WebFetch(*)` settings bug produced silently).
//
// Retrieval log: a `WebSearch` tool_use opens a search call with
// `input.query`; its tool_result string is
//   `Web search results for query: "…"\n\nLinks: [{"title","url"}, …]`
// and the JSON array after the literal `Links:` is the result set. A result
// that does not match that shape keeps `resultUrls: null` and logs a
// warning, so a CLI format change is visible. `WebFetch` opens a fetch call
// with `input.url`; its result set is the fetched URL itself.

const claudeWebTools = new Set(['WebSearch', 'WebFetch']);
const claudeLinksMarker = 'Links:';

export const parseClaudeCodeStream = (stdout: string): ParsedAgentStream => {
  const { events, torn } = parseNdjson(stdout);

  let result: JsonRecord | null = null;
  let sawTurnEvents = false;
  const calls: RetrievalCall[] = [];
  const pendingWebCalls = new Map<string, number>(); // tool_use_id → call idx
  let attempted = false;
  let succeeded = false;
  let reportedModel: string | undefined;

  for (const event of events) {
    if (event.type === 'assistant' && isRecord(event.message)) {
      sawTurnEvents = true;
      const content = event.message.content;

      // The response's own model, not the init event's configured alias
      // ("claude-opus-5[1m]"); the last turn is the one that answered.
      if (
        typeof event.message.model === 'string' &&
        event.message.model !== ''
      ) {
        reportedModel = event.message.model;
      }

      if (!Array.isArray(content)) {
        continue;
      }

      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') {
          continue;
        }

        const name = typeof block.name === 'string' ? block.name : '';

        if (!claudeWebTools.has(name)) {
          continue;
        }

        attempted = true;
        const input = isRecord(block.input) ? block.input : {};
        const call =
          name === 'WebSearch'
            ? searchCall(stringOr(input.query, ''))
            : fetchCall(stringOr(input.url, ''));

        const index = calls.push(call) - 1;

        if (typeof block.id === 'string') {
          pendingWebCalls.set(block.id, index);
        }
      }
    } else if (event.type === 'user' && isRecord(event.message)) {
      sawTurnEvents = true;
      const content = event.message.content;

      if (!Array.isArray(content)) {
        continue;
      }

      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_result') {
          continue;
        }

        const id =
          typeof block.tool_use_id === 'string' ? block.tool_use_id : '';

        const index = pendingWebCalls.get(id);

        if (index === undefined) {
          continue;
        }

        pendingWebCalls.delete(id);

        if (block.is_error === true) {
          continue;
        }

        succeeded = true;
        const call = calls[index];

        if (!call) {
          continue;
        }

        if (call.kind === 'search') {
          call.resultUrls = parseClaudeSearchResultUrls(
            toolResultText(block.content),
          );
        } else if (call.url) {
          call.resultUrls = [call.url];
        }
      }
    } else if (event.type === 'result') {
      result = event;
    }
  }

  if (!result) {
    throw new AgentStreamError(
      'parser',
      torn > 0
        ? 'Claude Code stream ended without a parseable result event (torn line)'
        : 'Claude Code stream ended without a result event',
    );
  }

  if (result.is_error === true || result.subtype !== 'success') {
    throw new AgentStreamError(
      'cli_error',
      `Claude Code returned an error result (subtype ${String(result.subtype)})`,
    );
  }

  if (Array.isArray(result.permission_denials)) {
    for (const denial of result.permission_denials) {
      if (!isRecord(denial)) {
        continue;
      }

      const tool = typeof denial.tool_name === 'string' ? denial.tool_name : '';

      if (claudeWebTools.has(tool)) {
        throw new RejectedWebToolError(
          'claude_code',
          tool,
          'listed in permission_denials — the probe settings do not allow it',
        );
      }
    }
  }

  if (typeof result.result !== 'string') {
    throw new AgentStreamError(
      'parser',
      'Claude Code result event carries no answer text',
    );
  }

  const usedWebSearch = resolveFlag({
    attempted,
    succeeded,
    parsedTurnEvents: sawTurnEvents,
    torn,
  });

  const retrieval: RetrievalLog = {
    exposure: surfaceRetrievalExposure.claude_code,
    calls,
  };

  assertRetrievalConsistency('claude_code', usedWebSearch, retrieval);

  return {
    text: result.result,
    usedWebSearch,
    retrieval,
    ...(reportedModel === undefined ? {} : { reportedModel }),
  };
};

// A tool_result's content is a string or an array of text blocks.
const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) =>
      isRecord(block) && typeof block.text === 'string' ? block.text : '',
    )
    .join('\n');
};

const parseClaudeSearchResultUrls = (text: string): string[] | null => {
  const marker = text.indexOf(claudeLinksMarker);
  const start = marker === -1 ? -1 : text.indexOf('[', marker);
  const json = start === -1 ? null : sliceJsonArray(text, start);
  let links: unknown = null;

  if (json) {
    try {
      links = JSON.parse(json);
    } catch {
      links = null;
    }
  }

  if (!Array.isArray(links)) {
    log.warn('Claude Code WebSearch result did not match the Links: shape', {
      head: text.slice(0, 200),
    });

    return null;
  }

  return links.flatMap((link) =>
    isRecord(link) && typeof link.url === 'string' ? [link.url] : [],
  );
};

// The JSON array starting at `start`, found by bracket depth outside string
// literals (the result string carries prose after the array).
const sliceJsonArray = (text: string, start: number): string | null => {
  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (char === '\\') {
        i += 1;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;

      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
};

// ---------------------------------------------------------------------------
// Codex — `codex exec --json`
// ---------------------------------------------------------------------------
// `item.started` / `item.completed` events with `item.type === 'web_search'`
// are the search calls; `agent_message` items carry the answer (the
// --output-last-message file the runner also reads is authoritative for the
// text, so `lastMessage` may be null here). Older CLI versions used
// `{ msg: { type: 'agent_message', message } }`; both shapes are accepted.
//
// Retrieval log (shapes verified 2026-09-03 on 0.150.1, fixtures
// codex-searched / codex-multi-query): a completed item's `item.query` is a
// DISPLAY string — the first query plus " ..." when the call ran several —
// so the queries come from `action.queries[]` (or `action.query` for a
// single-query call), and `item.query` is only the fallback, with the
// ellipsis stripped. An open-page call is reported as `action.type:
// 'other'` with the opened URL in `item.query`. The `item.started` twin
// carries an empty query and `action.type: 'other'` and is ignored. No
// result set is in the stream (`exposure: 'queries_only'`).

export type ParsedCodexEvents = {
  lastMessage: string | null;
  usedWebSearch: boolean | null;
  retrieval: RetrievalLog;
};

export const parseCodexEvents = (stdout: string): ParsedCodexEvents => {
  const { events, torn } = parseNdjson(stdout);

  let lastMessage: string | null = null;
  let sawTurnEvents = false;
  const calls: RetrievalCall[] = [];
  let attempted = false;
  let succeeded = false;

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';

    if (type.startsWith('item.') || type.startsWith('turn.')) {
      sawTurnEvents = true;
    }

    const item = isRecord(event.item) ? event.item : null;

    if (item?.type === 'web_search') {
      attempted = true;

      if (type === 'item.completed') {
        const errored =
          item.error !== undefined ||
          item.status === 'failed' ||
          item.status === 'error' ||
          item.status === 'rejected';

        if (errored) {
          throw new RejectedWebToolError(
            'codex',
            'web_search',
            `search item completed with an error marker: ${JSON.stringify(
              item.error ?? item.status,
            )}`,
          );
        }

        succeeded = true;
        calls.push(...codexCallsFromItem(item));
      }
    }

    const message = extractCodexAgentMessage(event);

    if (message) {
      sawTurnEvents = true;
      lastMessage = message;
    }
  }

  const usedWebSearch = resolveFlag({
    attempted,
    succeeded,
    parsedTurnEvents: sawTurnEvents,
    torn,
  });

  const retrieval: RetrievalLog = {
    exposure: surfaceRetrievalExposure.codex,
    calls,
  };

  assertRetrievalConsistency('codex', usedWebSearch, retrieval);

  return { lastMessage, usedWebSearch, retrieval };
};

const codexQueryEllipsisPattern = /\s*(?:\.\.\.|…)$/;

const codexCallsFromItem = (item: JsonRecord): RetrievalCall[] => {
  const action = isRecord(item.action) ? item.action : {};
  const displayQuery = stringOr(item.query, '').replace(
    codexQueryEllipsisPattern,
    '',
  );

  if (action.type === 'search') {
    const listed = Array.isArray(action.queries)
      ? action.queries.filter(
          (query): query is string =>
            typeof query === 'string' && query.length > 0,
        )
      : [];

    const queries =
      listed.length > 0
        ? listed
        : [stringOr(action.query, displayQuery)].filter((q) => q.length > 0);

    return queries.map(searchCall);
  }

  if (/^https?:\/\//i.test(displayQuery)) {
    return [
      {
        kind: 'open_page',
        query: null,
        url: displayQuery,
        resultUrls: [displayQuery],
        resultsComplete: true,
      },
    ];
  }

  return displayQuery.length > 0 ? [searchCall(displayQuery)] : [];
};

const extractCodexAgentMessage = (event: JsonRecord): string | null => {
  const item = event.item;

  if (isRecord(item) && item.type === 'agent_message') {
    if (typeof item.text === 'string') {
      return item.text;
    }
  }

  const msg = event.msg;

  if (isRecord(msg) && msg.type === 'agent_message') {
    if (typeof msg.message === 'string') {
      return msg.message;
    }
  }

  return null;
};

// ---------------------------------------------------------------------------
// Cursor — `cursor-agent -p --output-format stream-json`
// ---------------------------------------------------------------------------
// Detection reads ONLY `{ type: 'tool_call', subtype: 'completed',
// tool_call: { webSearchToolCall | webFetchToolCall: { result } } }`:
// `result.success` counts, `result.rejected` / `result.permissionDenied` is
// the rejected-tool failure. The `interaction_query` request/response pairs
// that precede each call are never consulted — the request fires even when
// the call is then rejected, which is exactly the false positive the old
// regex detection had. Shell/edit calls are ignored (the deny list keeps
// them permissionDenied; that is expected). The `result` event's `result`
// string is the answer.
//
// Retrieval log: `webSearchToolCall` opens a search call with
// `args.searchTerm` at its `started` event; the `completed` event's
// `result.success.references[].chunk` is a markdown list
// (`1. [title](url)` per line) parsed into the result set.
// `webFetchToolCall` opens a fetch call with `args.url`; its result set is
// `result.success.url`.

const cursorWebCallKeys = ['webSearchToolCall', 'webFetchToolCall'] as const;
const markdownLinkPattern = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;

export const parseCursorStream = (stdout: string): ParsedAgentStream => {
  const { events, torn } = parseNdjson(stdout);

  let result: JsonRecord | null = null;
  let sawTurnEvents = false;
  const calls: RetrievalCall[] = [];
  const callIndexById = new Map<string, number>();
  let attempted = false;
  let succeeded = false;

  for (const event of events) {
    if (event.type === 'assistant' || event.type === 'tool_call') {
      sawTurnEvents = true;
    }

    if (event.type === 'result') {
      result = event;
      continue;
    }

    if (event.type !== 'tool_call' || !isRecord(event.tool_call)) {
      continue;
    }

    for (const key of cursorWebCallKeys) {
      const call = event.tool_call[key];

      if (!isRecord(call)) {
        continue;
      }

      attempted = true;
      const args = isRecord(call.args) ? call.args : {};
      const callId = stringOr(event.call_id, stringOr(args.toolCallId, ''));
      let index = callId ? callIndexById.get(callId) : undefined;

      if (index === undefined) {
        index =
          calls.push(
            key === 'webSearchToolCall'
              ? searchCall(stringOr(args.searchTerm, ''))
              : fetchCall(stringOr(args.url, '')),
          ) - 1;

        if (callId) {
          callIndexById.set(callId, index);
        }
      }

      if (event.subtype !== 'completed' || !isRecord(call.result)) {
        continue;
      }

      const outcome = call.result;

      if ('success' in outcome) {
        succeeded = true;
        const logged = calls[index];
        const success = isRecord(outcome.success) ? outcome.success : {};

        if (logged?.kind === 'search') {
          logged.resultUrls = parseCursorSearchResultUrls(success);
        } else if (logged) {
          const url = stringOr(success.url, logged.url ?? '');
          logged.resultUrls = url ? [url] : null;
        }
      } else if ('rejected' in outcome || 'permissionDenied' in outcome) {
        throw new RejectedWebToolError(
          'cursor',
          key,
          `${'rejected' in outcome ? 'rejected' : 'permission denied'}${getCursorRefusalSuffix(outcome)}`,
        );
      }
    }
  }

  if (!result) {
    throw new AgentStreamError(
      'parser',
      torn > 0
        ? 'Cursor stream ended without a parseable result event (torn line)'
        : 'Cursor stream ended without a result event',
    );
  }

  if (result.is_error === true || result.subtype === 'error') {
    throw new AgentStreamError(
      'cli_error',
      `Cursor returned an error result (subtype ${String(result.subtype)})`,
    );
  }

  if (typeof result.result !== 'string' || result.result.length === 0) {
    throw new AgentStreamError(
      'parser',
      'Cursor result event carries no answer text',
    );
  }

  const usedWebSearch = resolveFlag({
    attempted,
    succeeded,
    parsedTurnEvents: sawTurnEvents,
    torn,
  });

  const retrieval: RetrievalLog = {
    exposure: surfaceRetrievalExposure.cursor,
    calls,
  };

  assertRetrievalConsistency('cursor', usedWebSearch, retrieval);

  return { text: result.result, usedWebSearch, retrieval };
};

const parseCursorSearchResultUrls = (success: JsonRecord): string[] | null => {
  const references = Array.isArray(success.references)
    ? success.references
    : [];

  const urls: string[] = [];

  for (const reference of references) {
    if (!isRecord(reference)) {
      continue;
    }

    const chunk = stringOr(reference.chunk, '');

    for (const match of chunk.matchAll(markdownLinkPattern)) {
      if (match[1]) {
        urls.push(match[1]);
      }
    }

    // A reference that carries its own URL (no markdown list) is one result.
    if (
      urls.length === 0 &&
      typeof reference.url === 'string' &&
      reference.url
    ) {
      urls.push(reference.url);
    }
  }

  if (urls.length === 0) {
    log.warn('Cursor web search result carried no parseable links', {
      head: JSON.stringify(success).slice(0, 200),
    });

    return null;
  }

  return urls;
};
