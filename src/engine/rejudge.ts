import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finalizeRevision, revisionsDir } from '../bundle/export';
import {
  derivedFile,
  predecessorDir,
  readDerivedFrom,
  type DerivedFrom,
} from '../bundle/lineage';
import { readRunInputs } from '../codex-workflow/run-inputs';
import { hasErrorCode } from '../stores/fs-errors';
import { localReportKey, type AuditFile } from './audit-file';
import { localRunDigests, runDirectoryState } from './local-run';
import { bankDir } from './run-configuration';
import { carryFrozenBindings } from './run-bindings';

const technicalFile = 'TECHNICAL.json';

// ============================================================================
// rejudge (specs/aeo-open-source-cli-spec.md §4.3, §5, §8.2): a derived run
// over a finished run's frozen captures. It is a new run (new run id, its
// own journal and budget) of the same measurement (the source's measurement
// id), so it never counts as a fresh collection, and it carries the source's
// finalized revision verbatim so its bundle verifies without the source
// directory. Nothing is probed again: every planned answer is in the bank
// it starts from.
// ============================================================================

export type RejudgeOptions = {
  source: string;
  target: string;
  file: AuditFile;
  secrets: readonly string[];
  acceptFindings?: boolean;
};

/**
 * prepareRejudgment sets up the target directory of a rejudgment and
 * returns its lineage; the caller then runs it as any local run.
 */
export const prepareRejudgment = async ({
  source,
  target,
  file,
  secrets,
  acceptFindings = false,
}: RejudgeOptions): Promise<DerivedFrom> => {
  if ((await runDirectoryState(target)) !== 'new') {
    // Running the same rejudgment again resumes it.
    const existing = await readDerivedFrom(target);

    if (existing) {
      return existing;
    }

    throw new Error(
      `Please choose an empty --output for the rejudgment: ${target} already holds a run.`,
    );
  }

  const inputs = await readRunInputs(source);

  if (!inputs) {
    throw new Error(`${source} is not a run directory: it has no INPUTS.json.`);
  }

  // What is being rejudged must be frozen first: the derived bundle names
  // this exact revision as its predecessor.
  const revision = await finalizeRevision(source, { secrets, acceptFindings });
  const planned = localRunDigests(file).measurement;

  if (planned !== revision.manifest.digests.measurement) {
    throw new Error(
      'audit.json describes another measurement than the run being rejudged: a rejudgment reuses the same captures, so the questions, surfaces and competitors must not change. Measure the new configuration with literally-aeo run in a new directory instead.',
    );
  }

  const reportKey = localReportKey(file);
  const lineage: DerivedFrom = {
    version: 1,
    kind: 'rejudge',
    runId: revision.manifest.run.id,
    revisionId: revision.manifest.revision.id,
    bundleDigest: revision.manifest.bundleDigest,
  };

  await mkdir(path.join(target, bankDir), { recursive: true });
  await copyFile(
    path.join(source, bankDir, `${reportKey}.jsonl`),
    path.join(target, bankDir, `${reportKey}.jsonl`),
  );
  await carryFrozenBindings(
    path.join(source, bankDir),
    path.join(target, bankDir),
  );
  // The technical checks are part of the measurement, like the captures:
  // a rejudgment judges the site as it was, never as it is today.
  await copyFile(
    path.join(source, technicalFile),
    path.join(target, technicalFile),
  ).catch((err: unknown) => {
    if (!hasErrorCode(err, 'ENOENT')) {
      throw err;
    }
  });
  await mkdir(path.join(target, revisionsDir), { recursive: true });
  await copyFile(
    path.join(source, revisionsDir, 'identity.json'),
    path.join(target, revisionsDir, 'identity.json'),
  );
  await cp(
    revision.dir,
    path.join(target, predecessorDir, lineage.revisionId),
    {
      recursive: true,
    },
  );
  await writeFile(
    path.join(target, derivedFile),
    `${JSON.stringify(lineage, null, 2)}\n`,
  );

  return lineage;
};
