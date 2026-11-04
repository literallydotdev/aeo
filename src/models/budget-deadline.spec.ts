import { describe, expect, it } from 'vitest';
import { ModelBudgetError, validateModelBudgetState } from './accounting';

// The elapsed deadline is the attempt's own (2026-09-13): a persisted ledger
// pinned to an earlier attempt's deadline is accepted under a later one, and
// only the dollar and token pins are immutable.
describe('accounting - validateModelBudgetState()', () => {
  const persisted = {
    limits: {
      maxUsd: 60,
      maxTokens: 20_000_000,
      deadlineAt: '2026-09-13T04:02:00.000Z',
    },
    calls: {},
  };

  it('should accept a later deadline with the same spend limits', () => {
    expect(() =>
      validateModelBudgetState(persisted, {
        maxUsd: 60,
        maxTokens: 20_000_000,
        deadlineAt: '2026-09-13T10:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('should accept raised dollar and token limits and refuse lowered ones', () => {
    expect(() =>
      validateModelBudgetState(persisted, {
        maxUsd: 90,
        maxTokens: 20_000_000,
        deadlineAt: '2026-09-13T10:00:00.000Z',
      }),
    ).not.toThrow();
    expect(() =>
      validateModelBudgetState(persisted, {
        maxUsd: 59,
        maxTokens: 20_000_000,
        deadlineAt: '2026-09-13T10:00:00.000Z',
      }),
    ).toThrow(ModelBudgetError);
  });
});
