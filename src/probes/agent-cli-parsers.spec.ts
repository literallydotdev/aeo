import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RejectedWebToolError,
  RetrievalConsistencyError,
  assertRetrievalConsistency,
  parseClaudeCodeStream,
  parseCodexEvents,
  parseCursorStream,
} from './agent-cli-parsers';

// Fixture transcripts captured from the installed CLIs (see
// __fixtures__/README.md for versions and cases). Synthetic variants — torn
// lines, error results, an errored Codex search item — are derived here so
// the shapes stay anchored to a real capture.

const fixture = (name: string): string => {
  return readFileSync(
    path.join(import.meta.dirname, '__fixtures__', name),
    'utf8',
  );
};

/** Cuts the last non-empty line in half — an interrupted final write. */
const tearLastLine = (stdout: string): string => {
  const lines = stdout.trimEnd().split('\n');
  const last = lines.pop() ?? '';

  return [...lines, last.slice(0, Math.floor(last.length / 2))].join('\n');
};

/** Cuts the first line matching `predicate` in half. */
const tearLine = (
  stdout: string,
  predicate: (event: Record<string, unknown>) => boolean,
): string => {
  let torn = false;

  return stdout
    .trimEnd()
    .split('\n')
    .map((line) => {
      if (torn) {
        return line;
      }

      const event = JSON.parse(line) as Record<string, unknown>;

      if (!predicate(event)) {
        return line;
      }

      torn = true;

      return line.slice(0, Math.floor(line.length / 2));
    })
    .join('\n');
};

const replaceResultEvent = (stdout: string, patch: Record<string, unknown>) => {
  return stdout
    .trimEnd()
    .split('\n')
    .map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;

      return event.type === 'result'
        ? JSON.stringify({ ...event, ...patch })
        : line;
    })
    .join('\n');
};

const emptyFullLog = { exposure: 'full', calls: [] };

describe('agent-cli-parsers - parseClaudeCodeStream()', () => {
  it('should flag a completed WebSearch call as true (ToolSearch loader ignored)', () => {
    const parsed = parseClaudeCodeStream(
      fixture('claude-code-searched.ndjson'),
    );

    expect(parsed.usedWebSearch).toBe(true);
    expect(parsed.text).toMatch(/v24\.20\.0/);
  });

  it('should report the model the response named, not the configured alias', () => {
    const parsed = parseClaudeCodeStream(
      fixture('claude-code-searched.ndjson'),
    );

    expect(parsed.reportedModel).toBe('claude-opus-5');
  });

  it('should log the search with its Links: result set and the fetch with its URL', () => {
    const { retrieval } = parseClaudeCodeStream(
      fixture('claude-code-searched.ndjson'),
    );

    expect(retrieval.exposure).toBe('full');
    expect(retrieval.calls).toHaveLength(2);
    expect(retrieval.calls[0]).toMatchObject({
      kind: 'search',
      query: 'current Node.js LTS version',
      url: null,
      resultsComplete: true,
    });

    expect(retrieval.calls[0]?.resultUrls).toHaveLength(9);
    expect(retrieval.calls[0]?.resultUrls?.slice(0, 2)).toEqual([
      'https://nodejs.org/en/blog/release/v24.14.0',
      'https://nodejs.org/en/blog/release/v22.11.0',
    ]);

    expect(retrieval.calls[1]).toEqual({
      kind: 'fetch',
      query: null,
      url: 'https://nodejs.org/en/download',
      resultUrls: ['https://nodejs.org/en/download'],
      resultsComplete: true,
    });
  });

  it('should flag a plain answer with no tool calls as false with an empty log', () => {
    const parsed = parseClaudeCodeStream(
      fixture('claude-code-no-tools.ndjson'),
    );

    expect(parsed.usedWebSearch).toBe(false);
    expect(parsed.text).toBe('OK');
    expect(parsed.retrieval).toEqual(emptyFullLog);
  });

  it('should NOT count ToolSearch loader calls as web tool use', () => {
    const parsed = parseClaudeCodeStream(
      fixture('claude-code-toolsearch-only.ndjson'),
    );

    expect(parsed.usedWebSearch).toBe(false);
    expect(parsed.retrieval).toEqual(emptyFullLog);
  });

  it('should throw the rejected-tool failure on a WebSearch permission denial', () => {
    expect(() =>
      parseClaudeCodeStream(fixture('claude-code-permission-denied.ndjson')),
    ).toThrow(RejectedWebToolError);
  });

  it('should throw on a torn result line instead of guessing an answer', () => {
    expect(() =>
      parseClaudeCodeStream(
        tearLastLine(fixture('claude-code-searched.ndjson')),
      ),
    ).toThrow(/torn line/);
  });

  it('should keep a call whose tool result was torn with unknown results and flag', () => {
    const torn = tearLine(
      fixture('claude-code-searched.ndjson'),
      (event) =>
        event.type === 'user' &&
        JSON.stringify(event).includes('Web search results for query'),
    );

    // The fetch that follows still completes, so the flag stays true; drop
    // it too so the search is the only web call.
    const searchOnly = torn
      .split('\n')
      .filter(
        (line) => !line.includes('WebFetch') || line.includes('ToolSearch'),
      )
      .filter((line) => !line.includes('Node.js Version Information'))
      .join('\n');

    const parsed = parseClaudeCodeStream(searchOnly);
    expect(parsed.usedWebSearch).toBeNull();
    expect(parsed.retrieval.calls).toEqual([
      {
        kind: 'search',
        query: 'current Node.js LTS version',
        url: null,
        resultUrls: null,
        resultsComplete: true,
      },
    ]);
  });

  it('should leave results unknown when the Links: shape is missing', () => {
    const reshaped = fixture('claude-code-searched.ndjson')
      .split('\n')
      .map((line) =>
        line.includes('Web search results for query')
          ? line.replace('Links: [', 'Results: [')
          : line,
      )
      .join('\n');

    const parsed = parseClaudeCodeStream(reshaped);
    expect(parsed.usedWebSearch).toBe(true);
    expect(parsed.retrieval.calls[0]?.resultUrls).toBeNull();
  });

  it('should throw on an error result', () => {
    const errored = replaceResultEvent(fixture('claude-code-no-tools.ndjson'), {
      subtype: 'error_during_execution',
      is_error: true,
    });

    expect(() => parseClaudeCodeStream(errored)).toThrow(/error result/);
  });

  it('should report null when the stream holds a result but no turn events', () => {
    const resultOnly = fixture('claude-code-no-tools.ndjson')
      .trimEnd()
      .split('\n')
      .filter(
        (line) => (JSON.parse(line) as { type: string }).type === 'result',
      )
      .join('\n');

    expect(parseClaudeCodeStream(resultOnly).usedWebSearch).toBeNull();
  });
});

describe('agent-cli-parsers - parseCodexEvents()', () => {
  it('should flag a completed web_search item as true', () => {
    const parsed = parseCodexEvents(fixture('codex-searched.ndjson'));
    expect(parsed.usedWebSearch).toBe(true);
    expect(parsed.lastMessage).toMatch(/v24/);
  });

  it('should log each completed query without results and ignore the empty-query twins', () => {
    const { retrieval } = parseCodexEvents(fixture('codex-searched.ndjson'));
    expect(retrieval).toEqual({
      exposure: 'queries_only',
      calls: [
        {
          kind: 'search',
          query: 'site:nodejs.org current Node.js LTS version download',
          url: null,
          resultUrls: null,
          resultsComplete: true,
        },
      ],
    });
  });

  it('should expand a multi-query search from action.queries and log an open-page action', () => {
    const { retrieval, usedWebSearch } = parseCodexEvents(
      fixture('codex-multi-query.ndjson'),
    );

    expect(usedWebSearch).toBe(true);
    expect(retrieval.calls).toEqual([
      {
        kind: 'search',
        query: 'Swarmia GitHub integration pricing per developer',
        url: null,
        resultUrls: null,
        resultsComplete: true,
      },
      {
        kind: 'search',
        query: 'LinearB GitHub integration pricing per developer',
        url: null,
        resultUrls: null,
        resultsComplete: true,
      },
      {
        kind: 'open_page',
        query: null,
        url: 'https://www.swarmia.com/pricing/',
        resultUrls: ['https://www.swarmia.com/pricing/'],
        resultsComplete: true,
      },
    ]);
  });

  it('should strip the display ellipsis when only item.query is available', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"id":"s","type":"web_search","query":"site:swarmia.com pricing GitHub integration ...","action":{"type":"search"}}}',
      '{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Answer."}}',
      '{"type":"turn.completed"}',
    ].join('\n');

    expect(
      parseCodexEvents(stdout).retrieval.calls.map((c) => c.query),
    ).toEqual(['site:swarmia.com pricing GitHub integration']);
  });

  it('should flag an agent message with no tool items as false with an empty log', () => {
    const parsed = parseCodexEvents(fixture('codex-no-tools.ndjson'));
    expect(parsed.usedWebSearch).toBe(false);
    expect(parsed.lastMessage).toBe('OK');
    expect(parsed.retrieval).toEqual({ exposure: 'queries_only', calls: [] });
  });

  it('should NOT match the literal "web_search" inside answer text', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"Codex supports web_search when enabled."}}',
      '{"type":"turn.completed"}',
    ].join('\n');

    expect(parseCodexEvents(stdout).usedWebSearch).toBe(false);
  });

  it('should keep true across a torn trailing line, but degrade false to null', () => {
    expect(
      parseCodexEvents(tearLastLine(fixture('codex-searched.ndjson')))
        .usedWebSearch,
    ).toBe(true);

    expect(
      parseCodexEvents(tearLastLine(fixture('codex-no-tools.ndjson')))
        .usedWebSearch,
    ).toBeNull();
  });

  it('should throw the rejected-tool failure on an errored web_search item', () => {
    const errored = fixture('codex-searched.ndjson')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const event = JSON.parse(line) as {
          type: string;
          item?: { type: string };
        };

        return event.type === 'item.completed' &&
          event.item?.type === 'web_search'
          ? JSON.stringify({
              ...event,
              item: { ...event.item, error: 'tool disabled' },
            })
          : line;
      })
      .join('\n');

    expect(() => parseCodexEvents(errored)).toThrow(RejectedWebToolError);
  });

  it('should throw the consistency failure when a search completed without any query', () => {
    // A synthetic stream: the web tool ran (flag true) but no call carries a
    // query, so the log would be empty — a parser bug, never a page state.
    const stdout = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"id":"s","type":"web_search","query":"","action":{"type":"other"}}}',
      '{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Answer."}}',
      '{"type":"turn.completed"}',
    ].join('\n');

    expect(() => parseCodexEvents(stdout)).toThrow(RetrievalConsistencyError);
  });
});

describe('agent-cli-parsers - parseCursorStream()', () => {
  it('should flag webSearchToolCall.result.success as true', () => {
    const parsed = parseCursorStream(fixture('cursor-searched.ndjson'));
    expect(parsed.usedWebSearch).toBe(true);
    expect(parsed.text).toMatch(/24/);
  });

  it('should NOT report the "Auto" selector as the model that answered', () => {
    const parsed = parseCursorStream(fixture('cursor-searched.ndjson'));

    expect(parsed.reportedModel).toBeUndefined();
  });

  it('should log the fetch and the search with its markdown-list result set, in stream order', () => {
    const { retrieval } = parseCursorStream(fixture('cursor-searched.ndjson'));
    expect(retrieval.exposure).toBe('full');
    expect(retrieval.calls).toHaveLength(2);
    expect(retrieval.calls[0]).toEqual({
      kind: 'fetch',
      query: null,
      url: 'https://nodejs.org/en/download/',
      resultUrls: ['https://nodejs.org/en/download/'],
      resultsComplete: true,
    });

    expect(retrieval.calls[1]).toMatchObject({
      kind: 'search',
      query: 'current Node.js LTS version',
      url: null,
      resultsComplete: true,
    });

    expect(retrieval.calls[1]?.resultUrls).toHaveLength(5);
    expect(retrieval.calls[1]?.resultUrls?.slice(0, 2)).toEqual([
      'https://github.com/nodejs/release?tab=readme-ov-file',
      'https://nodejs.org/en/blog/release/v24.20.0',
    ]);
  });

  it('should throw the rejected-tool failure when the search was rejected', () => {
    expect(() =>
      parseCursorStream(fixture('cursor-web-rejected.ndjson')),
    ).toThrow(RejectedWebToolError);
  });

  it('should ignore a permissionDenied shell call while the search succeeded', () => {
    const parsed = parseCursorStream(
      fixture('cursor-shell-denied-search-ok.ndjson'),
    );

    expect(parsed.usedWebSearch).toBe(true);
    expect(parsed.retrieval.calls.map((c) => c.kind)).toEqual([
      'search',
      'fetch',
    ]);
  });

  it('should never consult interaction_query requests', () => {
    // The rejected transcript carries approved-looking request events for
    // the search; only the tool_call completion decides.
    const requestsOnly = fixture('cursor-web-rejected.ndjson')
      .trimEnd()
      .split('\n')
      .filter((line) => {
        const event = JSON.parse(line) as { type: string };

        return event.type !== 'tool_call';
      })
      .join('\n');

    const parsed = parseCursorStream(requestsOnly);
    expect(parsed.usedWebSearch).toBe(false);
    expect(parsed.retrieval.calls).toEqual([]);
  });

  it('should keep a started call whose completion never arrived with unknown results', () => {
    const startedOnly = fixture('cursor-searched.ndjson')
      .trimEnd()
      .split('\n')
      .filter((line) => {
        const event = JSON.parse(line) as { type: string; subtype?: string };

        return !(event.type === 'tool_call' && event.subtype === 'completed');
      })
      .join('\n');

    const parsed = parseCursorStream(startedOnly);
    expect(parsed.usedWebSearch).toBeNull();
    expect(parsed.retrieval.calls.map((c) => c.resultUrls)).toEqual([
      null,
      null,
    ]);
  });

  it('should throw on a torn result line', () => {
    expect(() =>
      parseCursorStream(tearLastLine(fixture('cursor-searched.ndjson'))),
    ).toThrow(/torn line/);
  });

  it('should throw on an error result', () => {
    const errored = replaceResultEvent(fixture('cursor-searched.ndjson'), {
      subtype: 'error',
      is_error: true,
    });

    expect(() => parseCursorStream(errored)).toThrow(/error result/);
  });
});

describe('agent-cli-parsers - assertRetrievalConsistency()', () => {
  it('should reject a searched flag with no web call and a from-memory flag with calls', () => {
    expect(() =>
      assertRetrievalConsistency('claude_code', true, {
        exposure: 'full',
        calls: [],
      }),
    ).toThrow(RetrievalConsistencyError);

    expect(() =>
      assertRetrievalConsistency('cursor', false, {
        exposure: 'full',
        calls: [
          {
            kind: 'search',
            query: 'q',
            url: null,
            resultUrls: null,
            resultsComplete: true,
          },
        ],
      }),
    ).toThrow(RetrievalConsistencyError);
  });

  it('should assert nothing for unknown retrieval', () => {
    expect(() =>
      assertRetrievalConsistency('codex', null, {
        exposure: 'queries_only',
        calls: [],
      }),
    ).not.toThrow();
  });
});
