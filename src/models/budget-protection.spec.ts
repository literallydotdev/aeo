import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createFileModelAccounting,
  createMemoryModelAccounting,
} from './accounting';
import { withModelBudgetProtection } from './budget-protection';
import { resolveInternalModelProfile } from './profiles';

const profile = () => {
  const profile = resolveInternalModelProfile();

  for (const role of Object.values(profile.roles)) {
    role.maxInputTokens = 100;
    role.maxOutputTokens = 100;
    role.pricingUsdPerMillion = { input: 4000, output: 5000, cachedInput: 0 };
  }

  // Each call's maximum is $1 and 200 tokens.
  return profile;
};

const deadlineAt = new Date(Date.now() + 600_000).toISOString();

describe('budget-protection - withModelBudgetProtection()', () => {
  it('should fail closed on persisted strings and arrays instead of resetting spent budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeo-budget-state-'));

    try {
      const filename = join(directory, 'budget.json');
      const accounting = createFileModelAccounting({
        filename,
        limits: { maxUsd: 10, maxTokens: 1000, deadlineAt },
        assertOwned: async () => {},
      });

      for (const invalid of ['{"limits":{}}', [], null, 0]) {
        await writeFile(filename, JSON.stringify(invalid));

        await expect(
          accounting.reserve({
            callId: 'new',
            role: 'research',
            reservedUsd: 1,
            inputTokens: 1,
            maxOutputTokens: 1,
          }),
        ).rejects.toThrow('JSON object');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should leave adjudication and verified copy funded after prior analysis spend', async () => {
    const base = createMemoryModelAccounting({
      maxUsd: 5,
      maxTokens: 2000,
      deadlineAt,
    });

    const guarded = withModelBudgetProtection(base, profile());
    await guarded.reserve({
      callId: 'analysis',
      role: 'analyzer',
      reservedUsd: 2,
      inputTokens: 200,
      maxOutputTokens: 200,
    });

    await expect(
      guarded.reserve({
        callId: 'optional',
        role: 'research',
        reservedUsd: 0.1,
        inputTokens: 10,
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow('budget');

    await guarded.reserve({
      callId: 'adjudication',
      role: 'adjudication',
      reservedUsd: 1,
      inputTokens: 100,
      maxOutputTokens: 100,
    });
    await guarded.reserve({
      callId: 'copy',
      role: 'copy',
      reservedUsd: 1,
      inputTokens: 100,
      maxOutputTokens: 100,
    });
    await guarded.reserve({
      callId: 'verifier',
      role: 'premiseVerifier',
      reservedUsd: 1,
      inputTokens: 100,
      maxOutputTokens: 100,
    });

    expect(Object.keys(base.state.calls)).toHaveLength(4);
  });

  it('should NOT let concurrent optional calls jointly consume the protected floor', async () => {
    const base = createMemoryModelAccounting({
      maxUsd: 5,
      maxTokens: 2000,
      deadlineAt,
    });

    const guarded = withModelBudgetProtection(base, profile());
    const outcomes = await Promise.allSettled(
      [1, 2, 3].map((index) =>
        guarded.reserve({
          callId: `research-${index}`,
          role: 'research',
          reservedUsd: 1,
          inputTokens: 100,
          maxOutputTokens: 100,
        }),
      ),
    );

    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(2);
    expect(
      outcomes.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('should apply the same protection to search and extraction without lowering the host floor', async () => {
    for (const role of ['research_search', 'perception_claim_extraction']) {
      const base = createMemoryModelAccounting({
        maxUsd: 3,
        maxTokens: 2000,
        deadlineAt,
      });

      const guarded = withModelBudgetProtection(base, profile());

      await expect(
        guarded.reserve({
          callId: role,
          role,
          reservedUsd: 0.02,
          inputTokens: 0,
          maxOutputTokens: 0,
          minRemainingUsd: 0,
          minRemainingTokens: 0,
        }),
      ).rejects.toThrow('budget');
    }
  });

  it('should retain the reservation for unknown usage and release only unused money for a confirmed lower cost', async () => {
    const base = createMemoryModelAccounting({
      maxUsd: 4,
      maxTokens: 2000,
      deadlineAt,
    });

    const guarded = withModelBudgetProtection(base, profile());
    await guarded.reserve({
      callId: 'pending',
      role: 'research',
      reservedUsd: 1,
      inputTokens: 100,
      maxOutputTokens: 100,
    });

    await expect(
      guarded.reserve({
        callId: 'retry',
        role: 'research',
        reservedUsd: 0.1,
        inputTokens: 10,
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow();

    await guarded.settle('pending', {
      costUsd: 0.2,
      inputTokens: 20,
      outputTokens: 20,
    });

    await expect(
      guarded.reserve({
        callId: 'new-attempt',
        role: 'research',
        reservedUsd: 0.5,
        inputTokens: 50,
        maxOutputTokens: 50,
      }),
    ).resolves.toBeUndefined();
  });
});
