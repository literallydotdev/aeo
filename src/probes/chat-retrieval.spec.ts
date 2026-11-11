import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractAnthropicRetrieval,
  extractGatewaySearchRetrieval,
  extractGeminiRetrieval,
  extractOpenAiRetrieval,
  retrievalResultUrls,
  rewriteRetrievalUrls,
  type RetrievalStep,
} from './chat-retrieval';

// Captured AI SDK results (see __fixtures__/README.md) pin each surface's
// retrieval shape; synthetic parts cover the action types the capture did
// not exercise.

type ChatFixture = {
  steps: RetrievalStep[];
  providerMetadata: unknown;
};

const fixture = (name: string): ChatFixture => {
  return JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, '__fixtures__', 'chat', `${name}.json`),
      'utf8',
    ),
  ) as ChatFixture;
};

describe('chat-retrieval - extractOpenAiRetrieval()', () => {
  it('should record the search with its cited sources as an incomplete result set', () => {
    const log = extractOpenAiRetrieval(fixture('openai').steps);
    expect(log.exposure).toBe('full');
    expect(log.calls[0]).toMatchObject({
      kind: 'search',
      query: 'site:nodejs.org Node.js LTS version current',
      url: null,
      resultsComplete: false,
    });

    expect(log.calls[0]?.resultUrls).toContain(
      'https://nodejs.org/en/about/previous-releases',
    );
  });

  it('should record extra queries of one search action as their own calls without results', () => {
    const log = extractOpenAiRetrieval(fixture('openai').steps);
    expect(log.calls).toHaveLength(2);
    expect(log.calls[1]).toEqual({
      kind: 'search',
      query: 'site:nodejs.org/en about release schedule Node.js LTS',
      url: null,
      resultUrls: null,
      resultsComplete: false,
    });
  });

  it('should map openPage and findInPage actions to URL-driven calls', () => {
    const steps: RetrievalStep[] = [
      {
        content: [
          {
            type: 'tool-result',
            toolName: 'web_search',
            toolCallId: 'a',
            output: {
              action: { type: 'openPage', url: 'https://example.com/pricing' },
              sources: [{ type: 'url', url: 'https://example.com/pricing' }],
            },
          },
          {
            type: 'tool-result',
            toolName: 'web_search',
            toolCallId: 'b',
            output: {
              action: {
                type: 'findInPage',
                url: 'https://example.com/docs',
                pattern: 'pricing',
              },
            },
          },
          { type: 'text', text: 'ignored' },
        ],
      },
    ];

    expect(extractOpenAiRetrieval(steps).calls).toEqual([
      {
        kind: 'open_page',
        query: null,
        url: 'https://example.com/pricing',
        resultUrls: ['https://example.com/pricing'],
        resultsComplete: false,
      },
      {
        kind: 'find_in_page',
        query: null,
        url: 'https://example.com/docs',
        resultUrls: ['https://example.com/docs'],
        resultsComplete: false,
      },
    ]);
  });

  it('should yield an empty log for an empty step list', () => {
    expect(extractOpenAiRetrieval([])).toEqual({ exposure: 'full', calls: [] });
  });
});

describe('chat-retrieval - extractAnthropicRetrieval()', () => {
  it('should pair the tool-call query with its tool-result URLs', () => {
    const log = extractAnthropicRetrieval(fixture('anthropic').steps);
    expect(log.exposure).toBe('full');
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]).toMatchObject({
      kind: 'search',
      query: 'Node.js LTS version current 2026',
      resultsComplete: true,
    });

    expect(log.calls[0]?.resultUrls).toEqual(
      expect.arrayContaining([
        'https://nodejs.org/en/about/previous-releases',
        'https://endoflife.date/nodejs',
      ]),
    );
  });

  it('should record two searches in order and leave an error output as unknown results', () => {
    const steps: RetrievalStep[] = [
      {
        content: [
          {
            type: 'tool-call',
            toolName: 'web_search',
            toolCallId: '1',
            input: { query: 'first' },
          },
          {
            type: 'tool-result',
            toolName: 'web_search',
            toolCallId: '1',
            input: { query: 'first' },
            output: [{ type: 'web_search_result', url: 'https://a.example/' }],
          },
          {
            type: 'tool-call',
            toolName: 'web_search',
            toolCallId: '2',
            input: { query: 'second' },
          },
          {
            type: 'tool-result',
            toolName: 'web_search',
            toolCallId: '2',
            input: { query: 'second' },
            output: {
              type: 'web_search_tool_result_error',
              errorCode: 'max_uses_exceeded',
            },
          },
        ],
      },
    ];

    expect(extractAnthropicRetrieval(steps).calls).toEqual([
      {
        kind: 'search',
        query: 'first',
        url: null,
        resultUrls: ['https://a.example/'],
        resultsComplete: true,
      },
      {
        kind: 'search',
        query: 'second',
        url: null,
        resultUrls: null,
        resultsComplete: true,
      },
    ]);
  });

  it('should yield an empty log for an empty step list', () => {
    expect(extractAnthropicRetrieval([])).toEqual({
      exposure: 'full',
      calls: [],
    });
  });
});

describe('chat-retrieval - extractGeminiRetrieval()', () => {
  it('should list the grounding queries as partial-exposure searches without results', () => {
    const log = extractGeminiRetrieval(fixture('gemini').providerMetadata);
    expect(log).toEqual({
      exposure: 'partial',
      calls: [
        {
          kind: 'search',
          query: 'current Node.js LTS version September 2026',
          url: null,
          resultUrls: null,
          resultsComplete: true,
        },
        {
          kind: 'search',
          query: 'Node.js release schedule 2026',
          url: null,
          resultUrls: null,
          resultsComplete: true,
        },
      ],
    });
  });

  it('should read the google provider key as well as vertex', () => {
    const log = extractGeminiRetrieval({
      google: { groundingMetadata: { webSearchQueries: ['a', 'b', 'c'] } },
    });

    expect(log.calls.map((c) => c.query)).toEqual(['a', 'b', 'c']);
  });

  it('should yield an empty log when grounding metadata is absent', () => {
    expect(extractGeminiRetrieval(undefined)).toEqual({
      exposure: 'partial',
      calls: [],
    });
  });
});

describe('chat-retrieval - extractGatewaySearchRetrieval()', () => {
  it('should record every search of a captured answer with the results the tool returned', () => {
    const log = extractGatewaySearchRetrieval(fixture('gateway-search').steps);

    expect(log.exposure).toBe('full');
    expect(log.calls.map((call) => call.query)).toEqual([
      'current Node.js LTS version 2025 latest LTS release active LTS codename',
      'nodejs.org release schedule LTS current version November 2025',
      'Node.js 24 LTS 22 LTS which is current LTS version October 2025 release schedule',
      '"Node.js 26" LTS "Lithium" latest version v26.13.0 Active LTS October 2026 supported until April 2029',
      'nodejs.org download "Get Node.js" "LTS" recommended version today latest LTS line which major version',
    ]);
    // The results the fixture keeps of each search (see the README).
    expect(log.calls.map((call) => call.resultUrls?.length)).toEqual([
      9, 10, 7, 6, 8,
    ]);
    expect(log.calls[0]).toMatchObject({
      kind: 'search',
      url: null,
      resultsComplete: true,
    });
    expect(log.calls[0]?.resultUrls).toContain(
      'https://nodejs.org/en/about/previous-releases',
    );
  });
});

describe('chat-retrieval - rewriteRetrievalUrls()', () => {
  it('should resolve grounding redirects inside result sets before storage', () => {
    const redirect =
      'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc';

    const log = {
      exposure: 'full' as const,
      calls: [
        {
          kind: 'search' as const,
          query: 'q',
          url: null,
          resultUrls: [redirect, 'https://kept.example/'],
          resultsComplete: true,
        },
        {
          kind: 'search' as const,
          query: 'r',
          url: null,
          resultUrls: null,
          resultsComplete: true,
        },
      ],
    };

    expect(retrievalResultUrls(log)).toEqual([
      redirect,
      'https://kept.example/',
    ]);

    const rewritten = rewriteRetrievalUrls(
      log,
      new Map([[redirect, 'https://real.example/page']]),
    );

    expect(rewritten.calls[0]?.resultUrls).toEqual([
      'https://real.example/page',
      'https://kept.example/',
    ]);

    expect(rewritten.calls[1]?.resultUrls).toBeNull();
    // Untouched input.
    expect(log.calls[0]?.resultUrls?.[0]).toBe(redirect);
  });
});
