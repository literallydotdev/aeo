import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as AiModule from 'ai';
import { APICallError, NoOutputGeneratedError } from 'ai';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { probeTraceOf } from '../bundle/recorder';
import type { AeoChatSurface } from '../schema';
import {
  answeredStream,
  createFakeNetwork,
  failedStream,
  fakeGateway,
  openGoldenRecorder,
  readChatFixture,
  expectGolden,
  readGolden,
  readOperations,
  settle,
  spyTrace,
  type ChatFixture,
  type FakeNetwork,
} from './__fixtures__/golden-harness';
import type { ProbeTrace } from './probe-trace';
import { createDataForSeoProbeClient } from './dataforseo';
import { runProbesForPrompts, type ProbeResult } from './probes';
import { defaultProbeBindings } from './bindings';

// ============================================================================
// Golden pins of every chat probe path (probe adapters spec §7, phase 1):
// the banked probe, what the probe layer hands the journal port, the run
// journal a real recorder writes from it, the request each provider call
// carries and every network request. The expected values in
// __fixtures__/golden/chat-probes.json record 0.2.2. A refactor that is
// meant to preserve behaviour passes them unchanged; a failing pin is a
// behaviour change to find, never a file to regenerate.
// ============================================================================

type StreamOptions = {
  model: unknown;
  prompt?: unknown;
  messages?: unknown;
  maxOutputTokens?: unknown;
  toolChoice?: unknown;
  maxRetries?: unknown;
  tools?: Record<string, { id?: unknown; args?: unknown }>;
  onError?: (event: { error: unknown }) => void;
};

const provider = vi.hoisted(() => ({
  streamText: vi.fn<(options: StreamOptions) => unknown>(),
}));

vi.mock('ai', async () => ({
  ...(await vi.importActual<typeof AiModule>('ai')),
  streamText: (options: StreamOptions) => provider.streamText(options),
}));

const prompt = {
  id: 'p1',
  promptText: 'Which managed file stores suit a small engineering team?',
  category: 'product_recommendation',
};

/** The request a provider call carried, as the pins record it. */
const requestOf = (options: StreamOptions) => {
  return {
    model: options.model,
    prompt: options.prompt,
    messages: options.messages,
    maxOutputTokens: options.maxOutputTokens,
    toolChoice: options.toolChoice,
    maxRetries: options.maxRetries,
    tools:
      options.tools &&
      Object.entries(options.tools).map(([name, tool]) => ({
        name,
        id: tool.id,
        args: tool.args,
      })),
  };
};

const searchAnswer = (
  fixture: ChatFixture,
  extra: { modelId?: string; providerMetadata?: unknown } = {},
) => {
  return answeredStream({
    steps: fixture.steps,
    text: fixture.text,
    sources: fixture.sources,
    finishReason: 'stop',
    toolCalls: [],
    response: { modelId: extra.modelId, messages: [] },
    providerMetadata: extra.providerMetadata ?? fixture.providerMetadata,
  });
};

const serpWith = (items: unknown[]) => {
  return {
    status_code: 20000,
    status_message: 'Ok.',
    tasks: [
      {
        id: 'task-1',
        status_code: 20000,
        status_message: 'Ok.',
        result: [{ items }],
      },
    ],
  };
};

type ChatCase = {
  surface: AeoChatSurface;
  stream?: (options: StreamOptions, call: number) => unknown;
  network?: { serp?: unknown; redirects?: Record<string, string> };
  onResult?: () => Promise<void>;
};

let root: string;
let fixtures: Record<'openai' | 'anthropic' | 'gemini', ChatFixture>;
let golden: Record<string, unknown>;

beforeAll(async () => {
  fixtures = {
    openai: await readChatFixture('openai'),
    anthropic: await readChatFixture('anthropic'),
    gemini: await readChatFixture('gemini'),
  };
  golden = (await readGolden('chat-probes.json')) as Record<string, unknown>;
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-golden-chat-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  provider.streamText.mockReset();
  await rm(root, { recursive: true, force: true });
});

/** runCase runs one planned unit of `surface` through a real journal. */
const runCase = async ({ surface, stream, network, onResult }: ChatCase) => {
  const requests: unknown[] = [];
  const fakeNetwork: FakeNetwork = createFakeNetwork(network ?? {});
  let calls = 0;

  vi.stubGlobal('fetch', fakeNetwork.fetch);
  provider.streamText.mockImplementation((options) => {
    calls += 1;
    requests.push(requestOf(options));

    if (!stream) {
      throw new Error(`No stream is arranged for ${surface}.`);
    }

    return stream(options, calls);
  });

  const recorder = await openGoldenRecorder(root);
  const spy = spyTrace(probeTraceOf(recorder, 'probe'));
  const banked: ProbeResult[] = [];

  const [outcome] = await settle(
    runProbesForPrompts({
      geography: 'us',
      language: 'en',
      prompts: [prompt],
      surfaces: [surface],
      chatProbes: undefined,
      filter: (unit) => unit.runIndex === 1,
      trace: spy.trace,
      dependencies: {
        bindings: defaultProbeBindings,
        gateway: fakeGateway,
        dataForSeo: createDataForSeoProbeClient({
          login: 'golden-login',
          password: 'golden-password',
        }),
      },
      onResult:
        onResult ??
        ((result) => {
          banked.push(result);

          return Promise.resolve();
        }),
    }),
  );

  const pinned = {
    outcome,
    banked,
    port: spy.calls(),
    journal: await readOperations(root),
    requests,
    // Redirects resolve concurrently: what was requested is pinned, not
    // the order the pool happened to send it in.
    // Compared by code unit, not localeCompare, so no machine's collation
    // reorders them.
    network: [...fakeNetwork.requests].sort((a, b) =>
      a.url < b.url ? -1 : Number(a.url > b.url),
    ),
  };

  return pinned;
};

describe('probes - runProbesForPrompts() golden pins', () => {
  it('should bank ChatGPT with its cited sources, retrieval log and reported cost', async () => {
    const pinned = await runCase({
      surface: 'chatgpt',
      stream: () =>
        searchAnswer(fixtures.openai, {
          modelId: 'openai/gpt-5.4-mini-2026-03-17',
          providerMetadata: {
            ...(fixtures.openai.providerMetadata as object),
            gateway: { cost: '0.0123' },
          },
        }),
    });

    expectGolden(pinned, golden.chatgptSuccess);
  });

  it('should bank Gemini with its grounding redirects resolved, keeping one that does not resolve', async () => {
    const redirectUrls = fixtures.gemini.sources.flatMap((source) =>
      typeof source === 'object' && source !== null && 'url' in source
        ? [String(source.url)]
        : [],
    );
    // Every wrapper resolves to a page of its own but the last, which 404s.
    const redirects = Object.fromEntries(
      redirectUrls
        .slice(0, -1)
        .map((url, index) => [url, `https://source-${index + 1}.example/page`]),
    );

    const pinned = await runCase({
      surface: 'gemini',
      stream: () =>
        searchAnswer(fixtures.gemini, {
          providerMetadata: {
            ...(fixtures.gemini.providerMetadata as object),
            gateway: { cost: 0.004 },
          },
        }),
      network: { redirects },
    });

    expectGolden(pinned, golden.geminiSuccess);
  });

  it('should bank Claude with its search results and no reported cost', async () => {
    const pinned = await runCase({
      surface: 'claude',
      stream: () =>
        searchAnswer(fixtures.anthropic, {
          modelId: 'anthropic/claude-sonnet-4.5',
        }),
    });

    expectGolden(pinned, golden.claudeSuccess);
  });

  it('should bank Perplexity with its out-of-band sources appended', async () => {
    const pinned = await runCase({
      surface: 'perplexity',
      stream: () =>
        answeredStream({
          text: 'Acme Files suits small teams [1]. Rival Files is cheaper [2].  \n',
          sources: [
            {
              type: 'source',
              sourceType: 'url',
              id: 's1',
              url: 'https://acme.example/',
              title: 'Acme Files',
            },
            {
              type: 'source',
              sourceType: 'url',
              id: 's2',
              url: 'https://rival.example/pricing',
            },
            {
              type: 'source',
              sourceType: 'document',
              id: 's3',
              title: 'A document source',
            },
          ],
          response: { modelId: 'perplexity/sonar-pro' },
          providerMetadata: { gateway: { cost: 0.005 } },
        }),
    });

    expectGolden(pinned, golden.perplexitySuccess);
  });

  it('should fail Perplexity with empty text and sources as empty_answer after one retry', async () => {
    const pinned = await runCase({
      surface: 'perplexity',
      stream: () =>
        answeredStream({
          text: '  ',
          sources: [
            {
              type: 'source',
              sourceType: 'url',
              id: 's1',
              url: 'https://acme.example/',
              title: 'Acme Files',
            },
          ],
          response: {},
          providerMetadata: undefined,
        }),
    });

    expectGolden(pinned, golden.perplexityEmptyWithSources);
  });

  it('should bank the synthesis follow-up with the search call sources', async () => {
    const pinned = await runCase({
      surface: 'chatgpt',
      stream: (options) =>
        options.toolChoice === 'none'
          ? answeredStream({
              text: 'Acme Files is the simplest choice.',
              sources: [
                {
                  type: 'source',
                  sourceType: 'url',
                  id: 'f1',
                  url: 'https://follow-up.example/',
                  title: 'Follow-up source',
                },
              ],
              providerMetadata: { gateway: { cost: '0.002' } },
            })
          : answeredStream({
              steps: fixtures.openai.steps,
              text: '',
              sources: fixtures.openai.sources,
              finishReason: 'tool-calls',
              toolCalls: [{ toolName: 'web_search' }],
              response: {
                modelId: 'openai/gpt-5.4-mini',
                messages: [{ role: 'assistant', content: 'Searched.' }],
              },
              providerMetadata: { gateway: { cost: '0.010' } },
            }),
    });

    expectGolden(pinned, golden.followUpWithSearchSources);
  });

  it('should bank the synthesis follow-up with its own sources when the search call had none', async () => {
    const pinned = await runCase({
      surface: 'chatgpt',
      stream: (options) =>
        options.toolChoice === 'none'
          ? answeredStream({
              text: '  Acme Files is the simplest choice.  ',
              sources: [
                {
                  type: 'source',
                  sourceType: 'url',
                  id: 'f1',
                  url: 'https://follow-up.example/',
                  title: 'Follow-up source',
                },
              ],
              providerMetadata: undefined,
            })
          : answeredStream({
              steps: [],
              text: '',
              sources: [],
              finishReason: 'tool-calls',
              toolCalls: [],
              response: { messages: [] },
              providerMetadata: { gateway: { cost: '0.010' } },
            }),
    });

    expectGolden(pinned, golden.followUpWithOwnSources);
  });

  it('should fail a search whose synthesis follow-up also returns no text as empty_answer after one retry', async () => {
    const pinned = await runCase({
      surface: 'claude',
      stream: (options) =>
        options.toolChoice === 'none'
          ? answeredStream({
              text: '  ',
              sources: [],
              providerMetadata: undefined,
            })
          : answeredStream({
              steps: fixtures.anthropic.steps,
              text: '',
              sources: fixtures.anthropic.sources,
              finishReason: 'tool-calls',
              toolCalls: [{ toolName: 'web_search' }],
              response: { messages: [] },
              providerMetadata: undefined,
            }),
    });

    expectGolden(pinned, golden.followUpEmpty);
  });

  it('should bank an AI Overview with its references', async () => {
    const pinned = await runCase({
      surface: 'google_ai_overview',
      network: {
        serp: serpWith([
          { type: 'organic', url: 'https://acme.example/' },
          {
            type: 'ai_overview',
            markdown: 'Acme Files is a managed file store for small teams.\n',
            references: [
              {
                source: 'Acme Files',
                domain: 'acme.example',
                url: 'https://acme.example/docs',
                title: 'Acme Files docs',
                text: 'Managed file storage.',
              },
              {
                source: null,
                domain: null,
                url: 'https://rival.example/',
                title: null,
                text: null,
              },
            ],
          },
        ]),
      },
    });

    expectGolden(pinned, golden.aiOverviewReferences);
  });

  it('should bank an AI Overview with its Google redirects resolved and their domain labels dropped', async () => {
    const wrapped = 'https://google.com/goto?url=https://rival.example/blog';
    const unresolved = 'https://google.com/goto?url=https://gone.example/';

    const pinned = await runCase({
      surface: 'google_ai_overview',
      network: {
        serp: serpWith([
          {
            type: 'ai_overview',
            markdown: 'Rival Files publishes a comparison.',
            references: [
              {
                source: 'Rival Files',
                domain: 'google.com',
                url: wrapped,
                title: 'Rival blog',
                text: '',
              },
              {
                source: 'Gone',
                domain: 'google.com',
                url: unresolved,
                title: 'Gone page',
                text: '',
              },
            ],
          },
        ]),
        redirects: {
          [wrapped]:
            'https://www.google.com/goto?url=https://rival.example/blog',
          'https://www.google.com/goto?url=https://rival.example/blog':
            'https://rival.example/blog',
        },
      },
    });

    expectGolden(pinned, golden.aiOverviewRedirect);
  });

  it('should bank an AI Overview with empty markdown and references as the source block alone', async () => {
    const pinned = await runCase({
      surface: 'google_ai_overview',
      network: {
        serp: serpWith([
          {
            type: 'ai_overview',
            markdown: null,
            references: [
              {
                source: 'Acme Files',
                domain: 'acme.example',
                url: 'https://acme.example/docs',
                title: 'Acme Files docs',
                text: '',
              },
            ],
          },
        ]),
      },
    });

    expectGolden(pinned, golden.aiOverviewEmptyMarkdown);
  });

  it('should bank a SERP without an AI Overview as an honest absence', async () => {
    const pinned = await runCase({
      surface: 'google_ai_overview',
      network: {
        serp: serpWith([{ type: 'organic', url: 'https://acme.example/' }]),
      },
    });

    expectGolden(pinned, golden.aiOverviewNoOverview);
  });

  it('should record a retried failure and the attempt that succeeded after it', async () => {
    const pinned = await runCase({
      surface: 'chatgpt',
      stream: (options, call) =>
        call === 1
          ? failedStream(
              options.onError,
              new APICallError({
                message: 'Internal server error',
                url: 'https://gateway.example',
                requestBodyValues: {},
                statusCode: 500,
              }),
              new NoOutputGeneratedError(),
            )
          : searchAnswer(fixtures.openai),
    });

    expectGolden(pinned, golden.retriedFailure);
  });

  it('should record a capture whose banking failed, and fail the unit as persistence', async () => {
    const pinned = await runCase({
      surface: 'perplexity',
      stream: () =>
        answeredStream({
          text: 'Acme Files suits small teams.',
          sources: [],
          response: {},
          providerMetadata: undefined,
        }),
      onResult: () => Promise.reject(new Error('store down')),
    });

    expectGolden(pinned, golden.persistenceBankingFailed);
  });

  it('should fail the unit as persistence with the journal error when an operation cannot be opened or closed', async () => {
    provider.streamText.mockImplementation(() =>
      answeredStream({
        text: 'Acme Files suits small teams.',
        sources: [],
        response: {},
        providerMetadata: undefined,
      }),
    );

    const unit = (trace: ProbeTrace) => {
      return runProbesForPrompts({
        geography: 'us',
        language: 'en',
        prompts: [prompt],
        surfaces: ['perplexity'],
        chatProbes: undefined,
        filter: (u) => u.runIndex === 1,
        trace,
        dependencies: { bindings: defaultProbeBindings, gateway: fakeGateway },
      });
    };

    const [notOpened] = await settle(
      unit({ start: () => Promise.reject(new Error('read-only file system')) }),
    );
    const [notClosed] = await settle(
      unit({
        start: () =>
          Promise.resolve({
            id: 'op',
            end: () => Promise.reject(new Error('disk full')),
          }),
      }),
    );

    expectGolden({ notOpened, notClosed }, golden.persistenceJournal);
    expect(provider.streamText).toHaveBeenCalledTimes(1);
  });
});
