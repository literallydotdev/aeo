import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyFixtureConfig, finalDraft } from '../agents/__fixtures__/copy';
import type * as StructuredModule from '../models/structured';
import { generateStructured } from '../models/structured';
import type * as CopyModule from './copy';
import { validateCopyDraft } from './copy';
import { withCopy } from './loop';
import { runStage } from './stage';

// ============================================================================
// The copy stage's durability: the verifier's paid steps (the initial
// review, the edit, the recheck) each land on disk as they complete, so a
// retry after a transient failure resumes at the step that failed. The
// stage runner, the host verdict and the verifier's edit cache are real;
// only the model calls are scripted.
// ============================================================================

vi.mock('./copy', async (original) => {
  const fixtures = await import('../agents/__fixtures__/copy');

  return {
    ...(await original<typeof CopyModule>()),
    readSnapshot: () => Promise.resolve(fixtures.copyFixtureSnapshot),
    materializeCopyInputs: async () => {},
    validateCopyDraft: vi.fn(),
  };
});
vi.mock('../models/structured', async (original) => ({
  ...(await original<typeof StructuredModule>()),
  generateStructured: vi.fn(),
}));

const dirs: string[] = [];
beforeAll(() => {
  // The stage prepares an isolated Codex home; no session is started here.
  process.env.AI_GATEWAY_API_KEY = 'test-key';
});
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('Loop - withCopy() with a durable checkpoint', () => {
  it('should resume at the recheck after a transient recheck failure, without a second initial review or edit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeo-copy-durability-'));

    dirs.push(dir);

    const draft = finalDraft();
    const edited = { ...draft, confidence: 0.7 };
    const reviews = vi.mocked(validateCopyDraft);

    reviews
      .mockResolvedValueOnce({
        valid: false,
        outcome: 'invalid_copy',
        errors: [
          { path: 'hero.title', code: 'unsupported_premise', message: 'x' },
        ],
      } as never)
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({
        valid: true,
        outcome: 'valid',
        errors: [],
        copy: {},
        provenance: { kind: 'agent' },
        receipt: {},
      } as never);
    vi.mocked(generateStructured).mockResolvedValue({
      output: edited,
      usage: {
        callId: 'edit-1',
        requestedModel: 'test',
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      },
    });

    const ctx = await withCopy(
      {
        dir,
        brand: copyFixtureConfig.brand,
        answers: [],
        sections: copyFixtureConfig.sections.map((section) => section.key),
        root: process.cwd(),
        secrets: [],
        log: () => {},
      },
      {
        config: copyFixtureConfig,
        runId: 'run-1',
        configVersion: 1,
        grounding: null,
      },
    );

    const run = await runStage(
      { ...ctx, initialCopyDraft: draft, command: '/missing-implementer' },
      'write',
    );

    expect(run.ok).toBe(true);
    expect(run.summary).toMatchObject({ attempts: 1, refusals: 0 });
    // One initial review, one edit, the recheck that failed and its retry.
    expect(reviews.mock.calls.map((call) => call[0].draft)).toEqual([
      draft,
      edited,
      edited,
    ]);
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await readFile(path.join(dir, 'OUT/write.json'), 'utf8')),
    ).toHaveProperty('draft', edited);
  });
});
