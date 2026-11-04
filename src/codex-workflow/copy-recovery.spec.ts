import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyPassBudget, recoverEditorialRounds } from './copy-recovery';

describe('CopyRecovery - recoverEditorialRounds()', () => {
  it('should remove only evidenced operational failures from a legacy review count', () => {
    const unavailable = [
      'draft: Verification unavailable (model_budget_exhausted)',
    ];
    const finding = ['intro: Unsupported premise (premise_unsupported)'];
    const journal = (errors: string[][]) => {
      return errors
        .map((errors, index) => JSON.stringify({ attempt: index + 1, errors }))
        .join('\n');
    };

    expect(
      recoverEditorialRounds(
        { rounds: 5, errors: unavailable },
        journal(Array<string[]>(5).fill(unavailable)),
      ),
    ).toEqual({ rounds: 0, errors: [] });
    expect(
      recoverEditorialRounds(
        { rounds: 5, errors: finding },
        journal([finding, unavailable, finding, unavailable, finding]),
      ),
    ).toEqual({ rounds: 3, errors: finding });
    // A missing tail cannot turn unknown earlier rounds into extra allowance.
    expect(
      recoverEditorialRounds({ rounds: 5, errors: unavailable }, ''),
    ).toEqual({ rounds: 4, errors: [] });
    expect(
      recoverEditorialRounds(
        { rounds: 5, errors: finding },
        journal(Array<string[]>(5).fill(finding)),
      ),
    ).toEqual({ rounds: 5, errors: finding });
  });
});

describe('CopyRecovery - copyPassBudget()', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const directory = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeo-copy-budget-'));

    dirs.push(dir);

    return dir;
  };

  const admission = {
    passId: 'execution#copy-pipeline-notes',
    admittedAt: '2026-09-14T07:00:00.000Z',
    limits: {
      maxUsd: 60,
      maxTokens: 5_000_000,
      deadlineAt: '2026-09-14T13:00:00.000Z',
    },
  };

  it('should give late copy recovery the admitted time allowance without increasing its spending limits', async () => {
    const dir = await directory();
    const checkpoint = vi.fn(async () => {});
    const budget = await copyPassBudget({
      ...admission,
      dir,
      checkpoint,
      now: Date.parse('2026-09-14T14:00:00Z'),
    });

    expect(budget).toEqual({
      ...admission.limits,
      deadlineAt: '2026-09-14T20:00:00.000Z',
    });
    expect(checkpoint).toHaveBeenCalledWith(['PENDING/copy-budget.json']);
    expect(
      JSON.parse(
        await readFile(path.join(dir, 'PENDING/copy-budget.json'), 'utf8'),
      ),
    ).toMatchObject({
      passId: admission.passId,
      deadlineAt: budget.deadlineAt,
    });
  });

  it('should retain the same copy deadline after restoring the checkpoint into a replacement worker', async () => {
    const dir = await directory();
    const checkpoint = vi.fn(async () => {});
    const initial = await copyPassBudget({
      ...admission,
      dir,
      checkpoint,
      now: Date.parse('2026-09-14T14:00:00Z'),
    });

    const replacement = await directory();

    await cp(path.join(dir, 'PENDING'), path.join(replacement, 'PENDING'), {
      recursive: true,
    });

    const restored = await copyPassBudget({
      ...admission,
      dir: replacement,
      checkpoint,
      now: Date.parse('2026-09-14T18:00:00Z'),
    });

    expect(restored).toEqual(initial);
  });

  it('should start a new window for a different pass in the same work directory', async () => {
    const dir = await directory();
    const checkpoint = vi.fn(async () => {});
    const first = await copyPassBudget({
      ...admission,
      dir,
      checkpoint,
      now: Date.parse('2026-09-14T14:00:00Z'),
    });

    // The reviewer's next change request is its own pass: it gets the full
    // allowance from its own start, not the remainder of the earlier window.
    const next = await copyPassBudget({
      ...admission,
      passId: 'execution#copy-pipeline-later-notes',
      dir,
      checkpoint,
      now: Date.parse('2026-09-14T19:00:00Z'),
    });

    expect(first.deadlineAt).toBe('2026-09-14T20:00:00.000Z');
    expect(next.deadlineAt).toBe('2026-09-15T01:00:00.000Z');
    expect(
      JSON.parse(
        await readFile(path.join(dir, 'PENDING/copy-budget.json'), 'utf8'),
      ),
    ).toMatchObject({
      passId: 'execution#copy-pipeline-later-notes',
      deadlineAt: next.deadlineAt,
    });
  });

  it.each([admission.admittedAt, '2026-09-14T06:00:00.000Z', 'not a date'])(
    'should refuse an admission whose deadline is not after it: %s',
    async (deadlineAt) => {
      const dir = await directory();
      const checkpoint = vi.fn(async () => {});

      await expect(
        copyPassBudget({
          ...admission,
          limits: { ...admission.limits, deadlineAt },
          dir,
          checkpoint,
        }),
      ).rejects.toThrow('Copy pass has no valid admitted time allowance');
      expect(checkpoint).not.toHaveBeenCalled();
    },
  );

  it('should require the saved window to be durable before granting model time', async () => {
    const dir = await directory();
    const checkpoint = vi
      .fn()
      .mockRejectedValue(new Error('checkpoint unavailable'));
    const args = {
      ...admission,
      dir,
      checkpoint,
      now: Date.parse('2026-09-14T14:00:00Z'),
    };

    await expect(copyPassBudget(args)).rejects.toThrow(
      'checkpoint unavailable',
    );
    await expect(copyPassBudget(args)).rejects.toThrow(
      'checkpoint unavailable',
    );
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });
});
