import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAnswer, searchSourcesMarker } from '../answer-text';
import { createDataForSeoProbeClient } from '../dataforseo';
import { createDataForSeoChatGptAppAdapter } from './dataforseo-chatgpt-app';

// A captured live response (see ../__fixtures__/README.md) pins the shape
// the adapter reads; the item types the capture did not produce are
// derived from it, in the shape the buyer-question captures had.

type ChatGptBody = {
  tasks: {
    result: {
      model: string | null;
      items: Record<string, unknown>[];
      sources: unknown;
      fan_out_queries: unknown;
    }[];
  }[];
};

const fixture = (): ChatGptBody => {
  return JSON.parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        '..',
        '__fixtures__',
        'dataforseo',
        'chatgpt-app.json',
      ),
      'utf8',
    ),
  ) as ChatGptBody;
};

const resultOf = (body: ChatGptBody) => {
  const result = body.tasks[0]?.result[0];

  if (!result) {
    throw new Error('The fixture holds no result.');
  }

  return result;
};

const adapterOver = (body: unknown) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() => Promise.resolve(Response.json(body)));

  vi.stubGlobal('fetch', fetch);

  return {
    fetch,
    adapter: createDataForSeoChatGptAppAdapter({
      surface: 'chatgpt_app',
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

describe('dataforseo-chatgpt-app - createDataForSeoChatGptAppAdapter()', () => {
  it('should bank a captured answer with its sources, its searches, the model the scraper reported and the cost', async () => {
    const { adapter } = adapterOver(fixture());

    const answer = await adapter.probe(question, {});

    expect(answer.answerText).toMatch(
      /^\(Current LTS\) \*\*Node\.js v26\.13\.0 \(Lithium\)\*\*/,
    );
    expect(answer.sources).toEqual({
      format: 'search',
      sources: [
        {
          sourceType: 'url',
          url: 'https://nodejs.org/en/download',
          title: 'Official Node.js download page',
        },
        {
          sourceType: 'url',
          url: 'https://nodejs.org/en/download?trk=public_profile__posts-text&utm_source=chatgpt.com',
          title: 'Node.js',
        },
        {
          sourceType: 'url',
          url: 'https://github.com/nodejs/Release/blob/main/README.md?plain=1&utm_source=chatgpt.com',
          title: 'Release/README.md at main · nodejs/Release',
        },
        {
          sourceType: 'url',
          url: 'https://nodejs.org/en/about/previous-releases?utm_source=chatgpt.com',
          title: 'Node.js',
        },
      ],
    });
    expect(answer.retrieval).toEqual({
      exposure: 'partial',
      calls: [
        {
          kind: 'search',
          query:
            'current Node.js LTS version November 2026 official Node.js release schedule',
          url: null,
          resultUrls: null,
          resultsComplete: true,
        },
      ],
    });
    expect(answer.servedModel).toBe('gpt-6');
    expect(answer.reportedCostUsd).toBe(0.004);
    expect(renderAnswer(answer)).toContain(
      `${searchSourcesMarker}\n- Official Node.js download page: https://nodejs.org/en/download\n`,
    );
  });

  it('should record the request it dispatches: the endpoint and the market, with web search forced on', async () => {
    const { adapter, fetch } = adapterOver(fixture());

    await adapter.probe(question, {});

    expect(adapter.request(question)).toEqual({
      prompt: question,
      parameters: {
        endpoint: '/ai_optimization/chat_gpt/llm_scraper/live/advanced',
        language_code: 'en',
        location_code: 2840,
        force_web_search: true,
      },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced',
    );
    expect(sentTasks(fetch)).toEqual([
      {
        keyword: question,
        language_code: 'en',
        location_code: 2840,
        force_web_search: true,
      },
    ]);
  });

  it('should keep the prose and the tables of an answer, in page order, and leave its images out', async () => {
    const body = fixture();
    const result = resultOf(body);

    result.items = [
      { type: 'chat_gpt_text', markdown: 'Two stores stand out.' },
      {
        type: 'chat_gpt_table',
        markdown:
          '| Store | Best for |\n|--------|--------|\n| Acme Files | Small teams |\n\n',
      },
      {
        type: 'chat_gpt_images',
        markdown:
          '![Acme Files logo | Logo site](https://images.example.org/static/abc?purpose=fullsize)',
        items: [
          {
            type: 'chat_gpt_images_element',
            url: 'https://logos.example.org/acme-files.html',
            alt: 'Acme Files logo | Logo site',
          },
        ],
      },
      { type: 'chat_gpt_text', markdown: '**1\\. Acme Files**' },
    ];

    const answer = await adapterOver(body).adapter.probe(question, {});

    expect(answer.answerText).toBe(
      'Two stores stand out.\n\n| Store | Best for |\n|--------|--------|\n| Acme Files | Small teams |\n\n**1\\. Acme Files**',
    );
  });

  it('should bank an answer without sources, searches or a reported model as exactly that', async () => {
    const body = fixture();
    const result = resultOf(body);

    result.sources = null;
    result.fan_out_queries = null;
    result.model = null;

    const answer = await adapterOver(body).adapter.probe(question, {});

    expect(answer.sources).toEqual({ format: 'search', sources: [] });
    // No list of searches is a log that was not captured: the request
    // forced the search on, so it is never "searched nothing".
    expect(answer.retrieval).toBeNull();
    expect(answer).not.toHaveProperty('servedModel');
    expect(renderAnswer(answer)).toBe(answer.answerText);
  });

  it('should record an empty list of searches as the scraper reported it', async () => {
    const body = fixture();

    resultOf(body).fan_out_queries = [];

    const answer = await adapterOver(body).adapter.probe(question, {});

    expect(answer.retrieval).toEqual({ exposure: 'partial', calls: [] });
  });

  it('should bank an answer whose response reports no usable cost, with no cost', async () => {
    const body = fixture();

    Object.assign(body, { cost: 'free' });

    const answer = await adapterOver(body).adapter.probe(question, {});

    expect(answer.answerText).not.toBe('');
    expect(answer).not.toHaveProperty('reportedCostUsd');
  });

  it('should fail a completed task that carries no result as an empty answer', async () => {
    const body = fixture();
    const [task] = body.tasks;

    Object.assign(task ?? {}, { result: null });

    const { adapter } = adapterOver(body);
    const failure = await adapter
      .probe(question, {})
      .catch((error: unknown) => error);

    expect(adapter.classifyError(failure)).toEqual({
      kind: 'empty_answer',
      message: 'DataForSEO returned a completed ChatGPT task with no result.',
    });
  });

  it('should give a scrape the time the vendor documents for one', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    try {
      await adapterOver(fixture()).adapter.probe(question, {});

      expect(timeout).toHaveBeenCalledExactlyOnceWith(150_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    ['a result with no prose or table', [{ type: 'chat_gpt_images' }]],
    ['a result with no items', null],
  ])('should fail %s as an empty answer', async (_case, items) => {
    const body = fixture();

    Object.assign(resultOf(body), { items });

    const { adapter } = adapterOver(body);
    const failure = await adapter
      .probe(question, {})
      .catch((error: unknown) => error);

    expect(adapter.classifyError(failure).kind).toBe('empty_answer');
  });

  it('should refuse a model name longer than a model name is, as a parser failure', async () => {
    const body = fixture();

    resultOf(body).model = 'm'.repeat(201);

    const { adapter } = adapterOver(body);
    const failure = await adapter
      .probe(question, {})
      .catch((error: unknown) => error);

    expect(adapter.classifyError(failure).kind).toBe('parser');
  });
});
