import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileModelAccounting,
  createMemoryModelAccounting,
  ModelBudgetError,
  type ModelCallAccounting,
} from './accounting';

// ============================================================================
// Releasing a reservation (probe adapters spec §4.3): a call that was never
// dispatched leaves the ledger without a cost, unlike a settlement at $0; a
// settled call stays settled.
// ============================================================================

const limits = {
  maxUsd: 10,
  maxTokens: 1_000_000,
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

const reservation = {
  callId: 'probe:chatgpt:p1:1:1:test-call-1',
  role: 'probe:chatgpt',
  reservedUsd: 0.05,
  inputTokens: 0,
  maxOutputTokens: 0,
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-accounting-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ledgers = (): Array<[string, () => ModelCallAccounting]> => {
  return [
    ['memory', () => createMemoryModelAccounting(limits)],
    [
      'file',
      () =>
        createFileModelAccounting({
          filename: path.join(root, 'model-budget.json'),
          limits,
          assertOwned: () => Promise.resolve(),
        }),
    ],
  ];
};

describe('accounting - release()', () => {
  it.each(ledgers())(
    'should withdraw an unsettled reservation from the %s ledger, so the same budget can be reserved again',
    async (_name, create) => {
      const ledger = create();

      await ledger.reserve({ ...reservation, reservedUsd: 10 });
      await ledger.release(reservation.callId);

      await expect(
        ledger.reserve({ ...reservation, callId: 'next', reservedUsd: 10 }),
      ).resolves.toBeUndefined();
    },
  );

  it.each(ledgers())(
    'should refuse to release a settled call or one never reserved on the %s ledger',
    async (_name, create) => {
      const ledger = create();

      await ledger.reserve(reservation);
      await ledger.settle(reservation.callId, { costUsd: 0.01 });

      await expect(ledger.release(reservation.callId)).rejects.toThrow(
        ModelBudgetError,
      );
      await expect(ledger.release('unknown')).rejects.toThrow(
        'Model call was not reserved',
      );
    },
  );

  it('should leave no trace of a released call in the persisted ledger', async () => {
    const filename = path.join(root, 'model-budget.json');
    const ledger = createFileModelAccounting({
      filename,
      limits,
      assertOwned: () => Promise.resolve(),
    });

    await ledger.reserve(reservation);
    await ledger.release(reservation.callId);

    const persisted = JSON.parse(await readFile(filename, 'utf8')) as {
      calls: Record<string, unknown>;
    };

    expect(persisted.calls).toEqual({});
  });
});
