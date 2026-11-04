import { describe, expect, it, vi } from 'vitest';
import { askUntilCovered } from './coverage-rounds';

// The one re-ask loop every batched caller shares: ask only about what is
// still pending, keep what arrived, stop when a round makes no progress.

const items = ['a', 'b', 'c', 'd'];

describe('coverage-rounds - askUntilCovered()', () => {
  it('should ask again for only the pending items and keeps every earlier answer', async () => {
    const asked: number[][] = [];
    const result = await askUntilCovered({
      items,
      maxRounds: 3,
      ask: (pending) => {
        asked.push(pending.map((entry) => entry.index));

        // Round one skips the middle two; round two answers about them.
        const answering =
          asked.length === 1
            ? pending.filter((entry) => entry.index === 0 || entry.index === 3)
            : pending;

        return Promise.resolve({
          answered: answering.map(
            (entry) => [entry.index, `${entry.item}!`] as const,
          ),
        });
      },
    });

    expect(asked).toEqual([
      [0, 1, 2, 3],
      [1, 2],
    ]);
    expect([...result.answered]).toEqual([
      [0, 'a!'],
      [3, 'd!'],
      [1, 'b!'],
      [2, 'c!'],
    ]);
    expect(result.pending).toEqual([]);
    expect(result.rounds).toBe(2);
  });

  it('should stop after a round that adds nothing and refuses nothing', async () => {
    const ask = vi.fn().mockResolvedValue({ answered: [] });

    const result = await askUntilCovered({ items, maxRounds: 3, ask });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.pending).toEqual([0, 1, 2, 3]);
    expect(result.rounds).toBe(1);
  });

  it('should keep asking about a refused item until the rounds run out', async () => {
    // A refusal means the model addressed the item; a misquote on the first
    // pass is usually corrected on the second, so the round is progress.
    const ask = vi.fn().mockResolvedValue({ answered: [], refused: [1] });

    const result = await askUntilCovered({
      items: ['x', 'y'],
      maxRounds: 3,
      ask,
    });

    expect(ask).toHaveBeenCalledTimes(3);
    expect(result.pending).toEqual([0, 1]);
    expect(result.rounds).toBe(3);
  });

  it('should NEVER overwrite a settled answer and ignore answers it did not ask for', async () => {
    const answered = new Map<number, string>([[0, 'settled']]);
    const asked: number[][] = [];

    const result = await askUntilCovered({
      items,
      answered,
      maxRounds: 2,
      ask: (pending) => {
        asked.push(pending.map((entry) => entry.index));

        return Promise.resolve({
          answered: [
            [0, 'overwrite'],
            [1, 'b!'],
            [7, 'stranger'],
          ] as const,
          // A refusal of a settled or unknown item is not progress either.
          refused: [0, 7],
        });
      },
    });

    expect(asked).toEqual([
      [1, 2, 3],
      [2, 3],
    ]);
    expect(result.answered).toBe(answered);
    expect(result.answered.get(0)).toBe('settled');
    expect(result.answered.get(1)).toBe('b!');
    expect(result.answered.has(7)).toBe(false);
    expect(result.pending).toEqual([2, 3]);
  });

  it('should report every round and leave earlier answers in place when a later round throws', async () => {
    const answered = new Map<number, string>();
    const reports: unknown[] = [];

    const result = askUntilCovered({
      items,
      answered,
      maxRounds: 3,
      onRound: (report) => reports.push(report),
      ask: (pending, round) => {
        const [first] = pending;

        if (round === 2 || !first) {
          return Promise.reject(new Error('provider unavailable'));
        }

        return Promise.resolve({
          answered: [[first.index, 'first']] as const,
        });
      },
    });

    await expect(result).rejects.toThrow('provider unavailable');
    expect([...answered]).toEqual([[0, 'first']]);
    expect(reports).toEqual([
      { round: 1, asked: 4, added: 1, refused: 0, pending: 3 },
    ]);
  });

  it('should NOT ask at all when everything is already answered', async () => {
    const ask = vi.fn().mockResolvedValue({ answered: [] });

    const result = await askUntilCovered({
      items: ['a'],
      answered: new Map([[0, 'done']]),
      maxRounds: 3,
      ask,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(result).toEqual({
      answered: new Map([[0, 'done']]),
      pending: [],
      rounds: 0,
    });
  });
});
