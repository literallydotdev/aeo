import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportRun } from './export';
import { redactBundle, redactionsSchema } from './redact';
import { verifyBundle } from './verify';
import { readArchive } from './zip';
import { createSyntheticRun } from './__fixtures__/synthetic-run';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-redact-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const withholdAnswers = redactionsSchema.parse({
  version: 1,
  withhold: [
    { path: 'captures/units.json', reason: 'Confidential answers' },
    { path: 'captures/manifest.json', reason: 'Confidential answers' },
  ],
});

const outcomeOf = (
  verification: ReturnType<typeof verifyBundle>,
  id: string,
) => {
  return verification.checks.find((check) => check.id === id);
};

describe('redact - export --redact', () => {
  it('should verify the derivative with withheld checks not checkable, never failed', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));
    const full = await exportRun(run.dir);

    const result = await exportRun(run.dir, { redactions: withholdAnswers });
    const files = readArchive(await readFile(result.archive));
    const verification = verifyBundle(files, 'redacted');

    expect(result.archive.endsWith('.redacted.aeo.zip')).toBe(true);
    expect(files.has('captures/units.json')).toBe(false);
    expect(result.manifest.revision.predecessor).toEqual({
      id: full.manifest.revision.id,
      bundleDigest: full.manifest.bundleDigest,
    });
    expect(result.manifest.redactions?.[0]).toMatchObject({
      sha256: null,
      bytes: null,
    });
    expect(outcomeOf(verification, 'bundle.integrity')?.outcome).toBe('pass');
    expect(outcomeOf(verification, 'plan.accounted')?.code).toBe(
      'document_withheld',
    );
    expect(outcomeOf(verification, 'bundle.redactions')?.code).toBe('redacted');
    expect(verification.exitCode).toBe(3);
  });

  it('should produce the same derivative for the same redaction', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));

    const first = await exportRun(run.dir, { redactions: withholdAnswers });
    const again = await exportRun(run.dir, {
      redactions: withholdAnswers,
      output: path.join(root, 'again.aeo.zip'),
    });

    expect(again.archiveSha256).toBe(first.archiveSha256);
  });

  it('should fail integrity when a withheld file is in the bundle after all', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));
    const full = await exportRun(run.dir);
    const fullFiles = readArchive(await readFile(full.archive));
    const redacted = readArchive(
      await readFile(
        (await exportRun(run.dir, { redactions: withholdAnswers })).archive,
      ),
    );

    redacted.set(
      'captures/units.json',
      fullFiles.get('captures/units.json') ?? Buffer.alloc(0),
    );
    const verification = verifyBundle(redacted, 'smuggled');

    expect(outcomeOf(verification, 'bundle.integrity')?.outcome).toBe('fail');
  });

  it('should refuse a redaction that withholds nothing', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));
    const full = await exportRun(run.dir);
    const files = readArchive(await readFile(full.archive));

    const result = () =>
      redactBundle(
        files,
        full.manifest,
        redactionsSchema.parse({
          version: 1,
          withhold: [{ path: 'nothing.json', reason: 'x' }],
        }),
      );

    expect(result).toThrow(/withholds nothing/);
  });
});
