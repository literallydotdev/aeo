import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AiModule from 'ai';
import { APICallError, NoOutputGeneratedError } from 'ai';
import type {
  ProbeAttemptEnd,
  ProbeAttemptStart,
  ProbeTrace,
} from './probe-trace';
import { runProbesForPrompts } from './probes';
import { defaultProbeBindings } from './bindings';

// A search-required probe is two streams: the search call, then a synthesis
// follow-up when the first returns no prose. Each stream reports a provider
// failure through its own `onError` and then rejects every member with the
// SDK's causeless stand-in, so a failure read without unwrapping is
// classified as a CLI error and retried under the wrong policy.

type StreamOptions = {
  toolChoice?: string;
  maxOutputTokens?: number;
  onError?: (event: { error: unknown }) => void;
};

const provider = vi.hoisted(() => ({
  streamText: vi.fn<(options: StreamOptions) => unknown>(),
  gateway: vi.fn((id: string) => `gateway:${id}`),
}));

vi.mock('ai', async () => ({
  ...(await vi.importActual<typeof AiModule>('ai')),
  streamText: (options: StreamOptions) => provider.streamText(options),
}));

/** A settled stream: every member resolves from one answer. */
const answered = (fields: Record<string, unknown>) => {
  return new Proxy(
    {},
    { get: (_target, key) => Promise.resolve(fields[key as string]) },
  );
};

/** A stream whose provider failed: `onError` saw the failure, and every
 * member rejects with the SDK's stand-in that carries no cause. */
const failed = (options: StreamOptions, error: unknown) => {
  options.onError?.({ error });

  return new Proxy(
    {},
    { get: () => Promise.reject(new NoOutputGeneratedError()) },
  );
};

const searched = () => {
  return answered({
    steps: [],
    text: '',
    sources: [],
    finishReason: 'stop',
    toolCalls: [],
    response: { messages: [] },
    providerMetadata: undefined,
  });
};

describe('probes - runProbesForPrompts()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    provider.streamText.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it('should classify a capacity failure of the synthesis follow-up as capacity, not a CLI error', async () => {
    provider.streamText.mockImplementation((options) =>
      options.toolChoice === 'none'
        ? failed(
            options,
            new APICallError({
              message: 'Too many requests',
              url: 'https://gateway.example',
              requestBodyValues: {},
              statusCode: 429,
            }),
          )
        : searched(),
    );

    const run = runProbesForPrompts({
      geography: 'us',
      language: 'en',
      prompts: [{ id: 'p1', promptText: 'Which agency?', category: 'x' }],
      surfaces: ['chatgpt'],
      chatProbes: undefined,
      dependencies: {
        bindings: defaultProbeBindings,
        gateway: provider.gateway,
      },
      // One unit: the surface plans two runs per prompt.
      filter: (unit) => unit.runIndex === 1,
    });

    await vi.runAllTimersAsync();
    const [outcome] = await run;
    // The capacity policy: three attempts, each a search call and its
    // follow-up, then a typed failure that names what actually happened.
    expect(outcome).toMatchObject({
      status: 'failed',
      kind: 'capacity',
      attempts: 3,
      lastError: 'Too many requests',
    });

    expect(provider.streamText).toHaveBeenCalledTimes(6);
  });

  it.each([
    // The free-tier model reasons and searches through 2,000 tokens before
    // it writes: its adapter version gives both streams eight times that.
    {
      name: 'the default ChatGPT binding',
      surface: 'chatgpt',
      bindings: defaultProbeBindings,
      allowance: 16_000,
    },
    {
      name: 'a directory frozen on the released OpenAI adapter',
      surface: 'chatgpt',
      bindings: {
        ...defaultProbeBindings,
        chatgpt: { adapter: 'gateway.openai@1', model: 'openai/gpt-6-luna' },
      },
      allowance: 2000,
    },
    {
      name: 'the default Gemini binding',
      surface: 'gemini',
      bindings: defaultProbeBindings,
      allowance: 2000,
    },
    // The default Claude model's answers were cut off at 2,000.
    {
      name: 'the default Claude binding',
      surface: 'claude',
      bindings: defaultProbeBindings,
      allowance: 16_000,
    },
    {
      name: 'a directory frozen on the released Anthropic adapter',
      surface: 'claude',
      bindings: {
        ...defaultProbeBindings,
        claude: {
          adapter: 'gateway.anthropic@1',
          model: 'anthropic/claude-sonnet-5',
        },
      },
      allowance: 2000,
    },
  ] as const)(
    'should give $name its own output allowance, on the search call and on its follow-up',
    async ({ surface, bindings, allowance }) => {
      provider.streamText.mockImplementation((options) =>
        options.toolChoice === 'none'
          ? answered({
              text: 'Acme Files.',
              sources: [],
              providerMetadata: undefined,
            })
          : searched(),
      );

      const run = runProbesForPrompts({
        geography: 'us',
        language: 'en',
        prompts: [{ id: 'p1', promptText: 'Which agency?', category: 'x' }],
        surfaces: [surface],
        chatProbes: undefined,
        dependencies: { bindings, gateway: provider.gateway },
        filter: (unit) => unit.runIndex === 1,
      });

      await vi.runAllTimersAsync();
      const [outcome] = await run;

      expect(outcome).toMatchObject({ status: 'captured' });
      expect(
        provider.streamText.mock.calls.map(
          ([options]) => options.maxOutputTokens,
        ),
      ).toEqual([allowance, allowance]);
    },
  );

  it('should read a failure of the search call through its own stream as well', async () => {
    provider.streamText.mockImplementation((options) =>
      failed(
        options,
        new APICallError({
          message: 'Forbidden',
          url: 'https://gateway.example',
          requestBodyValues: {},
          statusCode: 403,
        }),
      ),
    );

    const run = runProbesForPrompts({
      geography: 'us',
      language: 'en',
      prompts: [{ id: 'p1', promptText: 'Which agency?', category: 'x' }],
      surfaces: ['chatgpt'],
      chatProbes: undefined,
      dependencies: {
        bindings: defaultProbeBindings,
        gateway: provider.gateway,
      },
      // One unit: the surface plans two runs per prompt.
      filter: (unit) => unit.runIndex === 1,
    });

    await vi.runAllTimersAsync();
    const [outcome] = await run;
    expect(outcome).toMatchObject({
      status: 'failed',
      kind: 'auth',
      attempts: 1,
    });

    expect(provider.streamText).toHaveBeenCalledTimes(1);
  });

  describe('with a run journal', () => {
    const fakeTrace = (endError?: Error) => {
      const starts: ProbeAttemptStart[] = [];
      const ends: ProbeAttemptEnd[] = [];
      const trace: ProbeTrace = {
        start: (attempt) => {
          starts.push(attempt);

          return Promise.resolve({
            id: `op-${starts.length}`,
            end: (result) => {
              ends.push(result);

              return endError ? Promise.reject(endError) : Promise.resolve();
            },
          });
        },
      };

      return { trace, starts, ends };
    };

    const perplexityUnit = (trace: ProbeTrace) => {
      return runProbesForPrompts({
        geography: 'us',
        language: 'en',
        prompts: [{ id: 'p1', promptText: 'Which agency?', category: 'x' }],
        surfaces: ['perplexity'],
        chatProbes: undefined,
        dependencies: {
          bindings: defaultProbeBindings,
          gateway: provider.gateway,
        },
        filter: (unit) => unit.runIndex === 1,
        trace,
      });
    };

    it('should record that the follow-up wrote an answer, and nothing of the kind when the search call wrote it', async () => {
      const chatgptUnit = (trace: ProbeTrace) => {
        return runProbesForPrompts({
          geography: 'us',
          language: 'en',
          prompts: [{ id: 'p1', promptText: 'Which agency?', category: 'x' }],
          surfaces: ['chatgpt'],
          chatProbes: undefined,
          dependencies: {
            bindings: defaultProbeBindings,
            gateway: provider.gateway,
          },
          filter: (unit) => unit.runIndex === 1,
          trace,
        });
      };
      const written = answered({
        steps: [],
        text: 'Acme is a good agency.',
        sources: [],
        finishReason: 'stop',
        toolCalls: [],
        response: { messages: [] },
        providerMetadata: undefined,
      });
      const byFollowUp = fakeTrace();
      const bySearchCall = fakeTrace();

      // The search call returns no prose; the follow-up writes the answer.
      provider.streamText.mockImplementation((options) =>
        options.toolChoice === 'none' ? written : searched(),
      );
      const followedUp = chatgptUnit(byFollowUp.trace);
      await vi.runAllTimersAsync();
      await followedUp;

      provider.streamText.mockImplementation(() => written);
      const direct = chatgptUnit(bySearchCall.trace);
      await vi.runAllTimersAsync();
      await direct;

      expect(byFollowUp.ends).toEqual([
        expect.objectContaining({ outcome: 'succeeded', fromFollowUp: true }),
      ]);
      expect(bySearchCall.ends).toHaveLength(1);
      expect(bySearchCall.ends[0]).not.toHaveProperty('fromFollowUp');
    });

    it('should record the attempt with the answer and the model the provider named', async () => {
      provider.streamText.mockImplementation(() =>
        answered({
          text: 'Acme is a good agency.',
          sources: [],
          response: { modelId: 'perplexity/sonar-2026-10' },
        }),
      );
      const { trace, starts, ends } = fakeTrace();

      const [outcome] = await perplexityUnit(trace);

      expect(starts).toEqual([
        expect.objectContaining({
          surface: 'perplexity',
          promptId: 'p1',
          attempt: 1,
          requestedModel: 'perplexity/sonar',
        }),
      ]);
      expect(ends).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          text: 'Acme is a good agency.',
          reportedModel: 'perplexity/sonar-2026-10',
        }),
      ]);
      expect(outcome).toMatchObject({
        status: 'captured',
        probe: { reportedModel: 'perplexity/sonar-2026-10' },
      });
    });

    it('should point each retry to the attempt it retries', async () => {
      provider.streamText.mockImplementation((options) =>
        failed(
          options,
          new APICallError({
            message: 'Too many requests',
            url: 'https://gateway.example',
            requestBodyValues: {},
            statusCode: 429,
          }),
        ),
      );
      const { trace, starts, ends } = fakeTrace();

      const run = perplexityUnit(trace);

      await vi.runAllTimersAsync();
      await run;

      expect(starts.map((attempt) => attempt.retryOf)).toEqual([
        undefined,
        'op-1',
        'op-2',
      ]);
      expect(ends.map((end) => end.outcome)).toEqual([
        'failed',
        'failed',
        'failed',
      ]);
    });

    it('should fail the unit as persistence without dispatching when its operation cannot be opened', async () => {
      const trace: ProbeTrace = {
        start: () => Promise.reject(new Error('read-only file system')),
      };

      const run = perplexityUnit(trace);

      await vi.runAllTimersAsync();
      const [outcome] = await run;

      expect(outcome).toMatchObject({
        status: 'failed',
        kind: 'persistence',
        attempts: 1,
      });
      expect(provider.streamText).not.toHaveBeenCalled();
    });

    it('should fail the unit as persistence, never probe again, when the outcome cannot be recorded', async () => {
      provider.streamText.mockImplementation(() =>
        answered({ text: 'An answer.', sources: [], response: {} }),
      );
      const { trace } = fakeTrace(new Error('disk full'));

      const [outcome] = await perplexityUnit(trace);

      expect(outcome).toMatchObject({ status: 'failed', kind: 'persistence' });
      expect(provider.streamText).toHaveBeenCalledTimes(1);
    });
  });
});
