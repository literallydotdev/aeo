import { describe, expect, it, vi } from 'vitest';
import {
  chargedTotal,
  createMemoryModelAccounting,
  ModelBudgetError,
} from '../models/accounting';
import { probeUsd } from '../models/cost-coefficients';
import { chargedProbeTrace } from './charged-trace';
import type { ProbeAttemptStart, ProbeTrace } from './probe-trace';

const attempt: ProbeAttemptStart = {
  surface: 'chatgpt',
  promptId: 'p1',
  promptText: 'Which managed Postgres suits a small team?',
  runIndex: 1,
  attempt: 1,
  requestedModel: 'openai/gpt-5.4-mini',
};

const ledgerOf = (maxUsd: number) => {
  return createMemoryModelAccounting({
    maxUsd,
    maxTokens: 1_000_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });
};

const mockEnd = vi.fn(() => Promise.resolve());
const mockStart = vi.fn(() => Promise.resolve({ id: 'op-1', end: mockEnd }));
const trace: ProbeTrace = { start: mockStart };

describe('charged-trace - chargedProbeTrace()', () => {
  it('should reserve a probe at its estimate before it starts and settle it at the reported cost', async () => {
    const ledger = ledgerOf(10);
    const charged = chargedProbeTrace(trace, ledger);

    const handle = await charged.trace.start(attempt);

    expect(Object.values(ledger.state.calls)[0]).toMatchObject({
      role: 'probe:chatgpt',
      reservedUsd: probeUsd.chatgpt.high,
    });

    await handle.end({
      outcome: 'succeeded',
      text: 'answer',
      retrieval: null,
      requestedModel: attempt.requestedModel,
      costUsd: 0.004,
    });

    expect(Object.values(ledger.state.calls)[0]?.usage?.costUsd).toBe(0.004);
  });

  it('should keep charging the estimate when the provider reported no cost, and record no cost', async () => {
    const ledger = ledgerOf(10);
    const handle = await chargedProbeTrace(trace, ledger).trace.start(attempt);

    await handle.end({
      outcome: 'failed',
      kind: 'timeout',
      error: 'timed out',
    });

    expect(Object.values(ledger.state.calls)[0]?.usage).toEqual({
      requestedModel: attempt.requestedModel,
      valid: false,
    });
    expect(chargedTotal(Object.values(ledger.state.calls)).usd).toBe(
      probeUsd.chatgpt.high,
    );
  });

  it('should NOT dispatch a probe the cap cannot afford, and report the refusal', async () => {
    const ledger = ledgerOf(probeUsd.chatgpt.high / 2);
    const charged = chargedProbeTrace(trace, ledger);

    await expect(charged.trace.start(attempt)).rejects.toThrow(
      ModelBudgetError,
    );
    expect(mockStart).not.toHaveBeenCalled();
    expect(charged.exhausted()).toBeInstanceOf(ModelBudgetError);
  });

  it("should charge nothing for a coding-agent probe on the operator's own login", async () => {
    const ledger = ledgerOf(0.001);

    await chargedProbeTrace(trace, ledger).trace.start({
      ...attempt,
      surface: 'claude_code',
      requestedModel: null,
    });

    expect(ledger.state.calls).toEqual({});
  });
});
