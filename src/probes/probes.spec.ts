import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GatewayModule from '@ai-sdk/gateway';
import type * as AiModule from 'ai';
import { APICallError, NoOutputGeneratedError } from 'ai';
import type {
  ProbeAttemptEnd,
  ProbeAttemptStart,
  ProbeTrace,
} from './probe-trace';
import { runProbesForPrompts } from './probes';

// A search-required probe is two streams: the search call, then a synthesis
// follow-up when the first returns no prose. Each stream reports a provider
// failure through its own `onError` and then rejects every member with the
// SDK's causeless stand-in, so a failure read without unwrapping is
// classified as a CLI error and retried under the wrong policy.

type StreamOptions = {
  toolChoice?: string;
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

vi.mock('@ai-sdk/gateway', async () => ({
  ...(await vi.importActual<typeof GatewayModule>('@ai-sdk/gateway')),
  gateway: provider.gateway,
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
        filter: (unit) => unit.runIndex === 1,
        trace,
      });
    };

    it('should record the attempt with the answer and the model the provider named', async () => {
      provider.streamText.mockImplementation(() =>
        answered({
          text: 'Acme is a good agency.',
          sources: [],
          response: { modelId: 'perplexity/sonar-pro-2026-10' },
        }),
      );
      const { trace, starts, ends } = fakeTrace();

      const [outcome] = await perplexityUnit(trace);

      expect(starts).toEqual([
        expect.objectContaining({
          surface: 'perplexity',
          promptId: 'p1',
          attempt: 1,
          requestedModel: 'perplexity/sonar-pro',
        }),
      ]);
      expect(ends).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          text: 'Acme is a good agency.',
          reportedModel: 'perplexity/sonar-pro-2026-10',
        }),
      ]);
      expect(outcome).toMatchObject({
        status: 'captured',
        probe: { reportedModel: 'perplexity/sonar-pro-2026-10' },
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
