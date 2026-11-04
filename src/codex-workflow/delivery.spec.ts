import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkflow, type WorkflowContext } from './loop';
import { isStageFresh, runStage, type StageRun } from './stage';
import { finishRun } from './finish';
import { validateCopyDraft } from './copy';

vi.mock('./stage', () => ({
  runStage: vi.fn(),
  isStageFresh: vi.fn(() => Promise.resolve(false)),
  stageInputsDigest: () => Promise.resolve('same-inputs'),
}));
vi.mock('./aggregate', () => ({
  aggregateWorkdir: () => Promise.resolve({ sections: {} }),
}));
vi.mock('./finish', () => ({ finishRun: vi.fn() }));
vi.mock('./copy', () => ({
  copywriterFiles: () => Promise.resolve({}),
  materializeCopyInputs: async () => {},
  readSnapshot: () => Promise.resolve({}),
  validateCopyDraft: vi.fn(),
}));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const context = async (): Promise<WorkflowContext> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aeo-delivery-'));

  dirs.push(dir);
  await mkdir(path.join(dir, 'OUT'));

  return {
    dir,
    answers: [],
    brand: { name: 'Example', domain: 'example.test' },
    sections: [],
    root: dir,
    secrets: [],
    log: () => {},
    checkpoint: vi.fn(async () => {}),
    aggregate: {},
    source: {
      config: { brand: { name: 'Example' }, sections: [] },
      request: { runId: 'run', configVersion: 1 },
      grounding: null,
    },
  } as unknown as WorkflowContext;
};

const stages = (ctx: WorkflowContext, acceptAt = Infinity) => {
  let rounds = 0;

  vi.mocked(runStage).mockImplementation(
    async (_ctx, stage): Promise<StageRun> => {
      if (stage === 'review') {
        rounds += 1;

        const accepted = rounds >= acceptAt;

        await writeFile(
          path.join(ctx.dir, 'OUT/review.json'),
          JSON.stringify({
            verdict: accepted ? 'accepted' : 'needs_another_pass',
            criteria: [],
            corrections: [],
            unresolved: accepted
              ? []
              : [
                  {
                    criterionId: 'evidence',
                    stage: 'analyze',
                    file: 'answer.md',
                    problem: `Unresolved finding ${rounds}`,
                    evidence: 'captured evidence',
                    whyNotFixed: 'Needs further research',
                  },
                ],
          }),
        );

        return {
          stage,
          model: 'test',
          ok: true,
          durationMs: 0,
          usage: null,
          errors: [],
          degraded: [],
          summary: {
            verdict: accepted ? 'accepted' : 'needs_another_pass',
            corrections: accepted ? 0 : 1,
            reused: 1,
          },
        };
      }

      return {
        stage,
        model: 'test',
        ok: stage !== 'write',
        durationMs: 0,
        usage: null,
        errors: stage === 'write' ? ['Unsupported headline remains'] : [],
        degraded: [],
        summary: { attempts: stage === 'write' ? 5 : 1 },
      };
    },
  );
  vi.mocked(finishRun).mockImplementation((args) =>
    Promise.resolve({
      snapshot: { meta: { quality: args.quality } },
      partialFailures: [],
      labelStats: {},
      written: 'skipped',
      snapshotFile: path.join(ctx.dir, 'OUT/snapshot.json'),
      grounding: null,
    } as unknown as Awaited<ReturnType<typeof finishRun>>),
  );
  vi.mocked(validateCopyDraft).mockResolvedValue({
    valid: true,
    outcome: 'valid',
    errors: [],
    copy: {},
    provenance: { kind: 'agent' },
    receipt: {},
  } as unknown as Awaited<ReturnType<typeof validateCopyDraft>>);
};

describe('Loop - runWorkflow()', () => {
  it('should deliver after five unresolved rounds, retaining findings and never re-entering earlier stages', async () => {
    const ctx = await context();

    stages(ctx);

    const result = await runWorkflow(ctx, { maxPasses: 100 });

    expect(vi.mocked(runStage).mock.calls.map((call) => call[1])).toEqual([
      'analyze',
      'qualify',
      ...Array<string>(5).fill('review'),
      'write',
    ]);
    expect(result.finish?.snapshot.meta.quality).toMatchObject({
      needsImprovement: true,
      reviewRounds: 5,
    });
    expect(result.finish?.snapshot.meta.quality?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Unresolved finding 5' }),
        expect.objectContaining({ code: 'narrative_needs_improvement' }),
      ]),
    );
    expect(result.copy).not.toBeNull();
    expect(result.copyOutcome).toBe('validated');
    expect(vi.mocked(validateCopyDraft).mock.calls[0]?.[0].draft).toMatchObject(
      {
        intro: [{ kind: 'fact', factId: 'aggregate:captured' }],
      },
    );
    expect(
      JSON.parse(
        await readFile(path.join(ctx.dir, 'REVIEW/progress.json'), 'utf8'),
      ),
    ).toMatchObject({ rounds: 5, accepted: false });
    vi.mocked(runStage).mockClear();
    await runWorkflow(ctx);
    expect(
      vi.mocked(runStage).mock.calls.filter((call) => call[1] === 'review'),
    ).toHaveLength(0);
  });

  it('should run another pass when the reused review said it needed one', async () => {
    const ctx = await context();

    stages(ctx, 1);
    // No progress file: the loop starts at pass 1 over a fresh review whose
    // recorded verdict asked for another pass.
    await writeFile(
      path.join(ctx.dir, 'OUT/review.json'),
      JSON.stringify({
        verdict: 'needs_another_pass',
        criteria: [],
        corrections: [],
        unresolved: [],
      }),
    );
    await writeFile(
      path.join(ctx.dir, 'OUT/review.result.json'),
      JSON.stringify({
        stage: 'review',
        ok: true,
        degraded: [],
        summary: { verdict: 'needs_another_pass', corrections: 0 },
      }),
    );
    vi.mocked(isStageFresh).mockImplementation((_ctx, stage) =>
      Promise.resolve(stage === 'review'),
    );

    try {
      const result = await runWorkflow(ctx);

      expect(
        vi.mocked(runStage).mock.calls.filter((call) => call[1] === 'review'),
      ).toHaveLength(1);
      expect(result.verdict).toBe('accepted');
    } finally {
      vi.mocked(isStageFresh).mockImplementation(() => Promise.resolve(false));
    }
  });

  it('should stop review early when no new issues remain', async () => {
    const ctx = await context();

    stages(ctx, 2);

    const result = await runWorkflow(ctx);

    expect(result.verdict).toBe('accepted');
    expect(
      vi.mocked(runStage).mock.calls.filter((call) => call[1] === 'review'),
    ).toHaveLength(2);
    expect(result.finish?.snapshot.meta.quality?.reviewRounds).toBe(2);
  });
});
