import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditFileSchema } from '../engine/audit-file';
import { prepareRejudgment } from '../engine/rejudge';
import { exampleAuditFile } from '../engine/templates';
import { exportRun, finalizeRevision, revisionsDir } from './export';
import { derivedFile, predecessorDir, type DerivedFrom } from './lineage';
import { readBundleSource } from './read';
import { verifyBundle } from './verify';
import { createSyntheticRun } from './__fixtures__/synthetic-run';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-lineage-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A derived run directory laid out as prepareRejudgment lays it out, over
 * the synthetic measurement (whose config is not an audit.json). */
const derivedRun = async () => {
  const source = await createSyntheticRun(path.join(root, 'source'));
  const revision = await finalizeRevision(source.dir);
  const target = await createSyntheticRun(path.join(root, 'rejudged'));
  const lineage: DerivedFrom = {
    version: 1,
    kind: 'rejudge',
    runId: revision.manifest.run.id,
    revisionId: revision.manifest.revision.id,
    bundleDigest: revision.manifest.bundleDigest,
  };

  await mkdir(path.join(target.dir, revisionsDir), { recursive: true });
  await cp(
    path.join(source.dir, revisionsDir, 'identity.json'),
    path.join(target.dir, revisionsDir, 'identity.json'),
  );
  await cp(
    revision.dir,
    path.join(target.dir, predecessorDir, lineage.revisionId),
    {
      recursive: true,
    },
  );
  await writeFile(path.join(target.dir, derivedFile), JSON.stringify(lineage));

  return { target, revision, lineage };
};

const lineageCheck = async (archive: string) => {
  const source = await readBundleSource(archive);
  const verification = verifyBundle(source.files, source.description);

  return verification.checks.find(
    (check) => check.id === 'lineage.predecessor',
  );
};

describe('lineage - a derived run', () => {
  it('should carry its predecessor and keep the measurement identity', async () => {
    const { target, revision, lineage } = await derivedRun();

    const result = await exportRun(target.dir);
    const check = await lineageCheck(result.archive);

    expect(result.manifest.run.derivedFrom).toEqual({
      kind: 'rejudge',
      runId: lineage.runId,
      revisionId: lineage.revisionId,
      bundleDigest: lineage.bundleDigest,
    });
    expect(result.manifest.run.measurementId).toBe(
      revision.manifest.run.measurementId,
    );
    expect(check?.outcome).toBe('pass');
  });

  it('should fail lineage for a predecessor altered before export', async () => {
    const { target, lineage } = await derivedRun();
    const manifestFile = path.join(
      target.dir,
      predecessorDir,
      lineage.revisionId,
      'manifest.json',
    );
    const manifest = await readFile(manifestFile, 'utf8');

    await writeFile(
      manifestFile,
      manifest.replace('"execution": "completed"', '"execution": "incomplete"'),
    );
    const result = await exportRun(target.dir);
    const check = await lineageCheck(result.archive);

    expect(check?.outcome).toBe('fail');
  });

  it('should report not applicable for a run that is not derived', async () => {
    const run = await createSyntheticRun(path.join(root, 'plain'));

    const result = await exportRun(run.dir);
    const check = await lineageCheck(result.archive);

    expect(check?.code).toBe('not_derived');
  });
});

describe('rejudge - prepareRejudgment()', () => {
  it('should refuse an audit.json of another measurement', async () => {
    const source = await createSyntheticRun(path.join(root, 'source'));

    const result = prepareRejudgment({
      source: source.dir,
      target: path.join(root, 'target'),
      file: auditFileSchema.parse(exampleAuditFile),
      secrets: [],
    });

    await expect(result).rejects.toThrow(/another measurement/);
  });
});

describe('project - author evidence', () => {
  it('should bundle the author record, the diff and the exact audit.json', async () => {
    const run = await createSyntheticRun(path.join(root, 'authored'));

    await writeFile(
      path.join(run.dir, 'AUDIT.json'),
      JSON.stringify(exampleAuditFile),
    );
    await writeFile(
      path.join(run.dir, 'AUTHOR-EVIDENCE.json'),
      JSON.stringify({
        kind: 'authored',
        reference: { runId: 'author-run-1', proposedDigest: 'a'.repeat(64) },
        record: { version: 1, runId: 'author-run-1' },
        diff: [{ path: '$.productBrief', from: 'a', to: 'b' }],
        unedited: false,
      }),
    );
    const result = await exportRun(run.dir);
    const source = await readBundleSource(result.archive);
    const declaration = JSON.parse(
      source.files.get('inputs/author/declaration.json')?.toString() ?? '{}',
    ) as { kind: string };

    expect(declaration.kind).toBe('authored');
    expect(source.files.has('inputs/author/record.json')).toBe(true);
    expect(source.files.has('inputs/author/diff.json')).toBe(true);
    expect(source.files.has('inputs/audit.json')).toBe(true);
  });
});
