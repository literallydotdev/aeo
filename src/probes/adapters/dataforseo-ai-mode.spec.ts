import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiModeSourcesMarker, renderAnswer } from '../answer-text';
import { createDataForSeoProbeClient } from '../dataforseo';
import { ProbeFailure } from '../failure';
import { createDataForSeoAiModeAdapter } from './dataforseo-ai-mode';

// A captured live response (see ../__fixtures__/README.md) pins the shape
// the adapter reads; the cases the capture did not produce are derived
// from it.

const fixture = (name: string): unknown => {
  return JSON.parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        '..',
        '__fixtures__',
        'dataforseo',
        `${name}.json`,
      ),
      'utf8',
    ),
  );
};

const adapterOver = (body: unknown) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() => Promise.resolve(Response.json(body)));

  vi.stubGlobal('fetch', fetch);

  return {
    fetch,
    adapter: createDataForSeoAiModeAdapter({
      surface: 'custom:ai_mode_under_test',
      client: createDataForSeoProbeClient({
        login: 'test-login',
        password: 'test-password',
      }),
      locale: { locationCode: 2840, languageCode: 'en' },
    }),
  };
};

/** The task array of the first request the client sent. */
const sentTasks = (fetch: ReturnType<typeof adapterOver>['fetch']): unknown => {
  const body = fetch.mock.calls[0]?.[1]?.body;

  if (typeof body !== 'string') {
    throw new Error('The client sent no JSON body.');
  }

  return JSON.parse(body);
};

const question = 'What is the current LTS version of Node.js?';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dataforseo-ai-mode - createDataForSeoAiModeAdapter()', () => {
  it('should bank a captured answer with its references and the cost the response reported', async () => {
    const { adapter } = adapterOver(fixture('ai-mode'));

    const answer = await adapter.probe(question, {});

    expect(answer.answerText).toMatch(
      /^The current Long-Term Support \(LTS\) version of Node\.js is \*\*Node\.js 26\*\*/,
    );
    expect(answer.sources).toEqual({
      format: 'ai_mode',
      references: [
        expect.objectContaining({
          domain: 'nodejs.org',
          url: 'https://nodejs.org/en/blog/release/v26.13.0',
        }),
      ],
    });
    expect(answer.retrieval).toEqual({ exposure: 'none', calls: [] });
    expect(answer.reportedCostUsd).toBe(0.004);
    expect(answer.servedModel).toBeUndefined();
    expect(answer.noOverview).toBeUndefined();
    expect(renderAnswer(answer)).toContain(
      `${aiModeSourcesMarker}\n- Node.js (nodejs.org): "Node.js — Node.js 26.13.0 (LTS)" — https://nodejs.org/en/blog/release/v26.13.0`,
    );
  });

  it('should record the request it dispatches: the endpoint and the market, with the question as the keyword', async () => {
    const { adapter, fetch } = adapterOver(fixture('ai-mode'));

    await adapter.probe(question, {});

    expect(adapter.request(question)).toEqual({
      prompt: question,
      parameters: {
        endpoint: '/serp/google/ai_mode/live/advanced',
        language_code: 'en',
        location_code: 2840,
      },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://api.dataforseo.com/v3/serp/google/ai_mode/live/advanced',
    );
    expect(sentTasks(fetch)).toEqual([
      { keyword: question, language_code: 'en', location_code: 2840 },
    ]);
  });

  it('should bank an answer that cites nothing, with no source block', async () => {
    const body = structuredClone(fixture('ai-mode')) as {
      tasks: { result: { items: { references: unknown }[] }[] }[];
    };
    const item = body.tasks[0]?.result[0]?.items[0];

    if (!item) {
      throw new Error('The fixture holds no answer item.');
    }

    // As 4 of 48 captured answers reported it.
    item.references = null;

    const answer = await adapterOver(body).adapter.probe(question, {});

    expect(renderAnswer(answer)).toBe(answer.answerText);
    expect(answer.answerText).not.toBe('');
  });

  it("should fail a captured search-engine error as retryable, never as an answer that didn't mention anyone", async () => {
    const { adapter } = adapterOver(fixture('ai-mode-failed'));

    const failure = await adapter.probe(question, {}).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ProbeFailure);
    expect(adapter.classifyError(failure)).toEqual({
      kind: 'cli_error',
      message: 'DataForSEO task 40101: Internal SE Server Error.',
    });
  });

  it.each(['api', 'task'] as const)(
    'should fail a %s-level "No Search Results" as an empty answer: AI Mode always answers in the product',
    async (level) => {
      // No 40102 came back in 50 live requests, so none is captured: this
      // is the captured failure with the documented code and message.
      const body = structuredClone(fixture('ai-mode-failed')) as {
        status_code: number;
        status_message: string;
        tasks: { status_code: number; status_message: string }[];
      };
      const failed = level === 'api' ? body : body.tasks[0];

      if (!failed) {
        throw new Error('The fixture holds no task.');
      }

      failed.status_code = 40102;
      failed.status_message = 'No Search Results.';

      const { adapter } = adapterOver(body);
      const failure = await adapter
        .probe(question, {})
        .catch((e: unknown) => e);

      expect(adapter.classifyError(failure).kind).toBe('empty_answer');
    },
  );

  it.each([
    ['a result without its answer item', { items: [{ type: 'organic' }] }],
    [
      'an answer item with no text',
      { items: [{ type: 'ai_overview', markdown: '  ', references: null }] },
    ],
  ])('should fail %s as an empty answer', async (_case, result) => {
    const { adapter } = adapterOver({
      status_code: 20000,
      cost: 0.004,
      tasks: [{ status_code: 20000, result: [result] }],
    });
    const failure = await adapter.probe(question, {}).catch((e: unknown) => e);

    expect(adapter.classifyError(failure).kind).toBe('empty_answer');
  });

  it('should fail every probe as an auth failure when the run has no DataForSEO client', async () => {
    const adapter = createDataForSeoAiModeAdapter({
      surface: 'custom:ai_mode_under_test',
      client: undefined,
      locale: { locationCode: 2840, languageCode: 'en' },
    });
    const failure = await adapter.probe(question, {}).catch((e: unknown) => e);

    expect(adapter.classifyError(failure).kind).toBe('auth');
  });
});
