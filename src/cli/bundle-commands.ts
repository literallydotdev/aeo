import path from 'node:path';
import {
  ExportBlockedError,
  exportRun,
  readFinalizedRevisions,
} from '../bundle/export';
import { projectWorkdir } from '../bundle/project';
import { readBundleSource } from '../bundle/read';
import { readRedactions } from '../bundle/redact';
import {
  refusedVerification,
  verifyBundle,
  type Verification,
} from '../bundle/verify';
import { WriterLockHeldError } from '../bundle/writer-lock';
import { BundleRefusedError } from '../bundle/zip';
import { readSettings } from '../engine/env-file';
import { runDirectoryState } from '../engine/local-run';
import { credentialSettingNames } from '../engine/preflight';
import { startViewer } from '../viewer/server';
import { formatLine, writeErr, writeOut, type Flags } from './io';

// ============================================================================
// export and verify (specs/aeo-open-source-cli-spec.md §4.3, §9, §10): no
// network, no provider, nothing uploaded.
// ============================================================================

const outcomeLabels = {
  pass: 'Passed',
  fail: 'FAILED',
  unsupported: 'Unsupported',
  not_checkable: 'Not checkable',
  not_applicable: 'Not applicable',
} as const;

const formatVerification = (verification: Verification): string => {
  const { bundle, disclosures } = verification;
  const lines = [`Checked: ${verification.source}`];

  if (bundle) {
    lines.push(
      formatLine('Run', `${bundle.runId} (${bundle.execution})`),
      formatLine('Revision', bundle.revisionId),
      formatLine('Bundle digest', bundle.bundleDigest),
      '',
    );
  }

  for (const check of verification.checks) {
    lines.push(formatLine(check.title, outcomeLabels[check.outcome]));

    if (check.outcome !== 'pass') {
      lines.push(`  ${check.code}: ${check.explanation}`);
    }
  }

  if (bundle) {
    const counted = (value: number | null) =>
      value === null ? 'unknown' : String(value);

    lines.push(
      '',
      formatLine(
        'Model metadata',
        `${counted(disclosures.capturesWithoutReportedModel)} of ${counted(disclosures.capturedAnswers)} captures lack a reported model ID`,
      ),
      formatLine('Unjudged answers', counted(disclosures.unjudgedAnswers)),
      formatLine(
        'Recorded corrections',
        counted(disclosures.recordedCorrections),
      ),
      formatLine(
        'Accepted export findings',
        counted(disclosures.acceptedFindings),
      ),
      formatLine('Trace coverage', disclosures.traceCoverage ?? 'unknown'),
      formatLine('Execution origin', bundle.origin),
      formatLine('Capture authenticity', 'Self-reported'),
      '',
      'Zero recorded corrections does not prove there were no unrecorded edits.',
    );
  }

  return lines.join('\n');
};

export const runExport = async (flags: Flags, usage: string) => {
  const dir = flags.positional[0];

  if (dir === undefined) {
    throw new Error(usage);
  }

  if ((await runDirectoryState(path.resolve(dir))) === 'new') {
    writeErr(
      [
        `${path.resolve(dir)} holds no run to export (it has no INPUTS.json).`,
        `  A local run: measure first with literally-aeo run --output ${dir}`,
        `  A hosted work directory from before INPUTS.json: pnpm aeo:codex prepare --report <reportKey> --workdir ${dir}`,
      ].join('\n'),
    );

    return 1;
  }

  const settings = await readSettings(flags.options.get('--env-file'));
  const redactFile = flags.options.get('--redact');
  const redactions = redactFile
    ? await readRedactions(path.resolve(redactFile))
    : undefined;

  try {
    const result = await exportRun(dir, {
      output: flags.options.get('--output'),
      redactions,
      secrets: settings.values(credentialSettingNames),
      acceptFindings: flags.switches.has('--accept-findings'),
    });

    if (flags.switches.has('--json')) {
      writeOut(
        JSON.stringify({
          resultVersion: 1,
          command: 'export',
          archive: result.archive,
          archiveSha256: result.archiveSha256,
          revisionId: result.manifest.revision.id,
          reusedRevision: result.reusedRevision,
          bundleDigest: result.manifest.bundleDigest,
        }),
      );
    } else {
      writeOut(
        [
          `Exported: ${result.archive}${result.manifest.redactions ? ` (redacted: ${result.manifest.redactions.length} files withheld; verification of what they held is not possible)` : ''}`,
          `Revision: ${result.manifest.revision.id}${result.reusedRevision ? ' (already finalized)' : ''}`,
          `Bundle digest: ${result.manifest.bundleDigest}`,
          `Archive sha256: ${result.archiveSha256}`,
          'Contains: the audit configuration, every captured answer, judgments, corrections, grounding sources and the report. Nothing was uploaded; share the file yourself.',
        ].join('\n'),
      );
    }

    return 0;
  } catch (err) {
    if (err instanceof ExportBlockedError) {
      writeErr(err.message);

      return 1;
    }

    // A live writer is a resumable stop (spec §4.3): export again later.
    if (err instanceof WriterLockHeldError) {
      writeErr(err.message);

      return 2;
    }

    throw err;
  }
};

export const runVerify = async (flags: Flags, usage: string) => {
  const target = flags.positional[0];

  if (target === undefined) {
    throw new Error(usage);
  }

  let verification: Verification;

  try {
    const source = await readBundleSource(target);

    verification = verifyBundle(source.files, source.description);
  } catch (err) {
    if (!(err instanceof BundleRefusedError)) {
      throw err;
    }

    // Nothing to check is invalid input, not a failed bundle.
    if (err.code === 'not_found' && !flags.switches.has('--json')) {
      writeErr(err.message);

      return 1;
    }

    verification = refusedVerification(path.resolve(target), {
      id: 'bundle.integrity',
      title: 'Bundle integrity',
      outcome: 'fail',
      code: err.code,
      explanation: err.message,
      artifacts: [],
    });
  }

  writeOut(
    flags.switches.has('--json')
      ? JSON.stringify({ resultVersion: 1, command: 'verify', ...verification })
      : formatVerification(verification),
  );

  return verification.exitCode;
};

/** view serves a bundle or a run directory on loopback until Ctrl-C. */
export const runView = async (flags: Flags, usage: string) => {
  const target = flags.positional[0];

  if (target === undefined) {
    throw new Error(usage);
  }

  const resolved = path.resolve(target);
  const revisions = await readFinalizedRevisions(resolved).catch(() => []);
  const isRunDirectory = await runDirectoryState(resolved).then(
    (state) => state !== 'new',
    () => false,
  );
  const working =
    isRunDirectory &&
    (flags.switches.has('--working') || revisions.length === 0);
  const bundle = working
    ? {
        files: (await projectWorkdir(resolved)).files,
        description: `${resolved} (working state)`,
        workingState: true,
      }
    : { ...(await readBundleSource(resolved)), workingState: false };
  const portOption = flags.options.get('--port');
  const viewer = await startViewer(bundle, {
    port: portOption === undefined ? 0 : Number(portOption),
  });

  writeOut(
    flags.switches.has('--json')
      ? JSON.stringify({ resultVersion: 1, command: 'view', url: viewer.url })
      : `Viewing ${bundle.description}\nOpen: ${viewer.url}\nPress Ctrl-C to stop.`,
  );

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await viewer.close();

  return 0;
};
