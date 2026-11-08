import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLog } from '../lib/log';
import { probeUsd } from '../models/cost-coefficients';
import type { ProbeAdapter, ProbeAnswer } from './adapter';
import {
  attemptRules,
  reportedModelOf,
  requestedModelOf,
  runProbeUnit,
  type BankedAnswer,
} from './attempt';
import { ProbeFailure } from './failure';
import { ProbeLimiter, unlimited } from './limits';
import type {
  ProbeAttemptEnd,
  ProbeAttemptStart,
  ProbeTrace,
} from './probe-trace';

// ============================================================================
// The host's attempt loop over a fake adapter (probe adapters spec §4.3,
// §8): the loop, not the adapter, opens and ends the journal, retries under
// the family's rules, finalises the answer and banks it, and never asks
// the adapter again once it has answered.
// ============================================================================

const log = createLog('AttemptSpec');

const unit = { promptId: 'p1', promptText: 'Which file store?', runIndex: 1 };

const fakeAdapter = (
  probe: ProbeAdapter['probe'],
  overrides: Partial<ProbeAdapter> = {},
): ProbeAdapter => {
  return {
    id: 'gateway.openai@1',
    surface: 'chatgpt',
    model: 'test-model-1',
    observes: { retrieval: 'full', servedModel: 'compare_to_requested' },
    settings: [],
    pool: 'gateway',
    retry: 'chat',
    estimateUsd: probeUsd['gateway.openai@1'],
    billing: 'metered',
    resolvesRedirects: false,
    request: (promptText) => ({
      prompt: `Asked: ${promptText}`,
      parameters: { model: 'test-model-1' },
    }),
    probe,
    classifyError: (error) =>
      error instanceof ProbeFailure
        ? { kind: error.kind, message: error.message }
        : { kind: 'cli_error', message: String(error) },
    ...overrides,
  };
};

const answerOf = (fields: Partial<ProbeAnswer> = {}): ProbeAnswer => {
  return {
    answerText: 'Acme Files.',
    sources: { format: 'none' },
    retrieval: { exposure: 'full', calls: [] },
    ...fields,
  };
};

const recordingTrace = () => {
  const calls: Array<ProbeAttemptStart | ProbeAttemptEnd> = [];
  const trace: ProbeTrace = {
    start: (attempt) => {
      calls.push(attempt);

      return Promise.resolve({
        id: `op-${calls.length}`,
        end: (result) => {
          calls.push(result);

          return Promise.resolve();
        },
      });
    },
  };

  return { trace, calls };
};

const toResult = (answer: BankedAnswer) => answer;

describe('attempt - runProbeUnit()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should open the operation before the probe and end it with the banked answer', async () => {
    const { trace, calls } = recordingTrace();
    const banked: BankedAnswer[] = [];
    const probe = vi.fn(() => {
      // The operation is open before the adapter is asked.
      expect(calls).toHaveLength(1);

      return Promise.resolve(
        answerOf({
          answerText: 'Acme\u0000 Files.',
          sources: {
            format: 'search',
            sources: [
              {
                sourceType: 'url',
                url: 'https://acme.example/',
                title: 'Acme',
              },
            ],
          },
          servedModel: 'test-model-1-2026',
          reportedCostUsd: 0.01,
        }),
      );
    });

    const outcome = await runProbeUnit(fakeAdapter(probe), unit, {
      rules: attemptRules.chat,
      trace,
      limiter: unlimited(),
      log,
      logContext: {},
      toResult,
      bank: (result) => {
        banked.push(result);

        return Promise.resolve();
      },
    });

    const text =
      'Acme Files.\n\nSources used by search:\n- Acme: https://acme.example/';

    expect(outcome).toMatchObject({ status: 'captured', attempts: 1 });
    expect(calls).toEqual([
      {
        surface: 'chatgpt',
        promptId: 'p1',
        promptText: 'Which file store?',
        runIndex: 1,
        attempt: 1,
        requestedModel: 'test-model-1',
        adapter: 'gateway.openai@1',
        request: {
          prompt: 'Asked: Which file store?',
          parameters: { model: 'test-model-1' },
        },
      },
      {
        outcome: 'succeeded',
        text,
        retrieval: { exposure: 'full', calls: [] },
        requestedModel: 'test-model-1',
        reportedModel: 'test-model-1-2026',
        costUsd: 0.01,
      },
    ]);
    expect(banked).toEqual([
      {
        text,
        retrieval: { exposure: 'full', calls: [] },
        requestedModel: 'test-model-1',
        reportedModel: 'test-model-1-2026',
      },
    ]);
  });

  it('should fail the unit as persistence and ask the adapter exactly once when its answer cannot be banked', async () => {
    const probe = vi.fn(() => Promise.resolve(answerOf()));

    const outcome = await runProbeUnit(fakeAdapter(probe), unit, {
      rules: attemptRules.chat,
      limiter: unlimited(),
      log,
      logContext: {},
      toResult,
      bank: () => Promise.reject(new Error('store down')),
    });

    expect(outcome).toEqual({
      status: 'failed',
      unit: { promptId: 'p1', surface: 'chatgpt', runIndex: 1 },
      kind: 'persistence',
      attempts: 1,
      lastError: 'store down',
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('should NOT ask the adapter when the operation cannot be opened', async () => {
    const probe = vi.fn(() => Promise.resolve(answerOf()));

    const outcome = await runProbeUnit(fakeAdapter(probe), unit, {
      rules: attemptRules.chat,
      trace: { start: () => Promise.reject(new Error('read-only')) },
      limiter: unlimited(),
      log,
      logContext: {},
      toResult,
    });

    expect(outcome).toMatchObject({ status: 'failed', kind: 'persistence' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('should retry under the family policy and point each retry to the attempt it retries', async () => {
    const { trace, calls } = recordingTrace();
    const probe = vi
      .fn<ProbeAdapter['probe']>()
      .mockRejectedValueOnce(new ProbeFailure('empty_answer', 'no text'))
      .mockResolvedValueOnce(answerOf());

    const run = runProbeUnit(fakeAdapter(probe), unit, {
      rules: attemptRules.chat,
      trace,
      limiter: unlimited(),
      log,
      logContext: {},
      toResult,
    });

    await vi.runAllTimersAsync();
    const outcome = await run;

    expect(outcome).toMatchObject({ status: 'captured', attempts: 2 });
    expect(calls).toEqual([
      expect.objectContaining({ attempt: 1 }),
      { outcome: 'failed', kind: 'empty_answer', error: 'no text' },
      expect.objectContaining({ attempt: 2, retryOf: 'op-1' }),
      expect.objectContaining({ outcome: 'succeeded' }),
    ]);
  });

  it('should pause only the adapter that hit capacity, never another surface on its pool', async () => {
    const limiter = unlimited();
    const perplexityProbe = vi
      .fn<ProbeAdapter['probe']>()
      .mockRejectedValueOnce(new ProbeFailure('capacity', 'Too many requests'))
      .mockResolvedValue(answerOf());
    const chatgptProbe = vi.fn(() => Promise.resolve(answerOf()));
    const host = {
      rules: attemptRules.chat,
      limiter,
      log,
      logContext: {},
      toResult,
    };

    const perplexity = runProbeUnit(
      fakeAdapter(perplexityProbe, {
        id: 'gateway.perplexity@1',
        surface: 'perplexity',
      }),
      unit,
      host,
    );

    // Perplexity's first attempt meets capacity and pauses its adapter.
    await vi.advanceTimersByTimeAsync(0);

    const chatgpt = runProbeUnit(fakeAdapter(chatgptProbe), unit, host);
    const secondPerplexity = runProbeUnit(
      fakeAdapter(perplexityProbe, {
        id: 'gateway.perplexity@1',
        surface: 'perplexity',
      }),
      { ...unit, runIndex: 2 },
      host,
    );

    await vi.advanceTimersByTimeAsync(0);

    // The gateway pool serves both: ChatGPT is not held back, Perplexity is.
    expect(chatgptProbe).toHaveBeenCalledOnce();
    expect(perplexityProbe).toHaveBeenCalledOnce();

    await vi.runAllTimersAsync();

    await expect(chatgpt).resolves.toMatchObject({ status: 'captured' });
    await expect(perplexity).resolves.toMatchObject({
      status: 'captured',
      attempts: 2,
    });
    await expect(secondPerplexity).resolves.toMatchObject({
      status: 'captured',
    });
  });

  it('should jitter a chat retry around its ladder delay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const probe = vi
      .fn<ProbeAdapter['probe']>()
      .mockRejectedValueOnce(new ProbeFailure('capacity', 'Too many requests'))
      .mockResolvedValue(answerOf());

    const run = runProbeUnit(fakeAdapter(probe), unit, {
      rules: attemptRules.chat,
      limiter: unlimited(),
      log,
      logContext: {},
      toResult,
    });

    // The ladder says 60 seconds; +20% jitter makes it 72.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(probe).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(run).resolves.toMatchObject({
      status: 'captured',
      attempts: 2,
    });
  });

  it('should NOT dispatch a unit whose run was aborted while it waited for a pool slot', async () => {
    const limiter = new ProbeLimiter({
      gateway: 1,
      dataforseo: 1,
      claude_code: 1,
      codex: 1,
      cursor: 1,
      analyzer: 1,
    });
    const controller = new AbortController();
    let finishFirst: (answer: ProbeAnswer) => void = () => undefined;
    const first = vi.fn(
      () =>
        new Promise<ProbeAnswer>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const queued = vi.fn(() => Promise.resolve(answerOf()));
    const { trace, calls } = recordingTrace();
    const host = {
      rules: attemptRules.chat,
      trace,
      limiter,
      signal: controller.signal,
      log,
      logContext: {},
      toResult,
    };

    const holding = runProbeUnit(fakeAdapter(first), unit, host);
    const waiting = runProbeUnit(
      fakeAdapter(queued),
      { ...unit, runIndex: 2 },
      host,
    );

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    finishFirst(answerOf());

    await expect(holding).resolves.toMatchObject({ status: 'captured' });
    await expect(waiting).resolves.toMatchObject({
      status: 'failed',
      kind: 'timeout',
      attempts: 0,
      lastError: 'run aborted before the unit executed',
    });
    expect(queued).not.toHaveBeenCalled();
    // Only the first unit opened an operation.
    expect(
      calls.filter((call) => 'attempt' in call && 'promptId' in call),
    ).toHaveLength(1);
  });

  it('should stop before dispatch once the run is aborted', async () => {
    const probe = vi.fn(() => Promise.resolve(answerOf()));
    const controller = new AbortController();

    controller.abort();

    const outcome = await runProbeUnit(fakeAdapter(probe), unit, {
      rules: attemptRules.agent,
      limiter: unlimited(),
      signal: controller.signal,
      log,
      logContext: {},
      toResult,
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      kind: 'timeout',
      attempts: 0,
    });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('attempt - requestedModelOf()', () => {
  it('should prefer the bound model, then the answered one, then none', () => {
    expect(requestedModelOf({ model: 'bound' }, 'answered')).toBe('bound');
    expect(requestedModelOf({}, 'answered')).toBe('answered');
    expect(requestedModelOf({}, null)).toBeNull();
    expect(requestedModelOf({})).toBeNull();
  });
});

describe('attempt - reportedModelOf()', () => {
  const answer = (servedModel?: string) => answerOf({ servedModel });
  const adapter = (servedModel: ProbeAdapter['observes']['servedModel']) =>
    fakeAdapter(() => Promise.resolve(answerOf()), {
      observes: { retrieval: 'full', servedModel },
    });

  it('should record a served model equal to the requested one as unknown', () => {
    const compare = adapter('compare_to_requested');

    expect(reportedModelOf(compare, answer('test-model-1'))).toBeUndefined();
    expect(reportedModelOf(compare, answer('test-model-1-2026'))).toBe(
      'test-model-1-2026',
    );
  });

  it('should keep what a CLI reported, and record nothing for an adapter that observes no model', () => {
    expect(reportedModelOf(adapter('raw'), answer('cli-model'))).toBe(
      'cli-model',
    );
    expect(reportedModelOf(adapter('raw'), answer(''))).toBeUndefined();
    expect(reportedModelOf(adapter('none'), answer('any'))).toBeUndefined();
  });
});
