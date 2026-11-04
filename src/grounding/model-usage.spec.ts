import { describe, expect, it, vi } from 'vitest';
import { createMemoryModelAccounting } from '../models/accounting';
import { trackResearchUsage } from './model-usage';

describe('model-usage - trackResearchUsage()', () => {
  it('should settle every provider call in one research operation and retain unknown usage on failure', async () => {
    const accounting = createMemoryModelAccounting({
      maxUsd: 10,
      maxTokens: 10000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });
    const receipt = vi.fn();

    const result = trackResearchUsage(
      async (tracked) => {
        await tracked.reserve({
          callId: 'known',
          role: 'adjudication',
          reservedUsd: 1,
          inputTokens: 100,
          maxOutputTokens: 900,
        });

        await tracked.settle('known', {
          costUsd: 0.1,
          inputTokens: 80,
          outputTokens: 20,
        });

        await tracked.reserve({
          callId: 'unknown',
          role: 'adjudication',
          reservedUsd: 1,
          inputTokens: 100,
          maxOutputTokens: 900,
        });

        throw new Error('connection lost');
      },
      { accounting, onUsage: receipt },
    );

    await expect(result).rejects.toThrow('connection lost');
    expect(receipt).toHaveBeenCalledExactlyOnceWith({ usd: 1.1, tokens: 1100 });
    expect(accounting.state.calls.known?.usage?.costUsd).toBe(0.1);
    expect(accounting.state.calls.unknown?.usage).toBeUndefined();
  });
});
