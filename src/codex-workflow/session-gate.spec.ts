import { describe, expect, it } from 'vitest';
import {
  createMemoryModelAccounting,
  ModelBudgetError,
} from '../models/accounting';
import { reserveWhenAffordable } from './session-gate';

// ============================================================================
// A cap near a run's real cost: each session reserves $2 of a $5 cap and
// settles at $0.50. Two fit at once; the third must wait for one to end,
// never stop the run.
// ============================================================================

const ledgerOf = (maxUsd: number) => {
  return createMemoryModelAccounting({
    maxUsd,
    maxTokens: 1_000_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });
};

const sessionOn = (ledger: ReturnType<typeof ledgerOf>, callId: string) => {
  return async () => {
    await ledger.reserve({
      callId,
      role: 'stage:analyze',
      reservedUsd: 2,
      inputTokens: 0,
      maxOutputTokens: 0,
    });

    return callId;
  };
};

describe('session-gate - reserveWhenAffordable()', () => {
  it('should hold a session the cap cannot afford yet until a running one settles, then start it', async () => {
    const ledger = ledgerOf(5);
    const first = await reserveWhenAffordable(ledger, sessionOn(ledger, 'a'));
    const second = await reserveWhenAffordable(ledger, sessionOn(ledger, 'b'));
    let started = false;
    const third = reserveWhenAffordable(ledger, sessionOn(ledger, 'c')).then(
      (session) => {
        started = true;

        return session;
      },
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(started).toBe(false);

    await ledger.settle(first.charge, { costUsd: 0.5 });
    first.ended();

    expect((await third).charge).toBe('c');
    expect(Object.keys(ledger.state.calls)).toEqual(['a', 'b', 'c']);
    second.ended();
  });

  it('should refuse as the ledger does when no session is running to give budget back', async () => {
    const ledger = ledgerOf(5);
    const first = await reserveWhenAffordable(ledger, sessionOn(ledger, 'a'));
    const second = await reserveWhenAffordable(ledger, sessionOn(ledger, 'b'));

    // Both ended without reporting a cost: their reservations stay.
    first.ended();
    second.ended();

    await expect(
      reserveWhenAffordable(ledger, sessionOn(ledger, 'c')),
    ).rejects.toMatchObject({ kind: 'exhausted' });
  });

  it('should stop waiting, still refused, when the session it waited for gave nothing back', async () => {
    const ledger = ledgerOf(5);
    const first = await reserveWhenAffordable(ledger, sessionOn(ledger, 'a'));
    const second = await reserveWhenAffordable(ledger, sessionOn(ledger, 'b'));
    const third = reserveWhenAffordable(ledger, sessionOn(ledger, 'c'));

    first.ended();
    second.ended();
    // Counted once however often it is told.
    second.ended();

    await expect(third).rejects.toBeInstanceOf(ModelBudgetError);
  });

  it('should pass on any other failure at once, and stop waiting when the run is stopped', async () => {
    const ledger = ledgerOf(5);
    const running = await reserveWhenAffordable(ledger, sessionOn(ledger, 'a'));

    await reserveWhenAffordable(ledger, sessionOn(ledger, 'b'));
    await expect(
      reserveWhenAffordable(ledger, () =>
        Promise.reject(new Error('The journal could not be written.')),
      ),
    ).rejects.toThrow('The journal could not be written.');

    const controller = new AbortController();
    const waiting = reserveWhenAffordable(
      ledger,
      sessionOn(ledger, 'c'),
      controller.signal,
    );

    controller.abort(new Error('Interrupted.'));

    await expect(waiting).rejects.toThrow('Interrupted.');
    running.ended();
  });
});
