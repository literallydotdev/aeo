import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { mintRunId } from '../lib/run-id';
import { hasErrorCode } from '../stores/fs-errors';
import { exportBeforeFreezeMessage } from '../engine/run-method';
import {
  bundleManifestSchema,
  bundlePaths,
  bundleSchemaVersion,
  canonicalization,
  digestManifest,
  toolId,
  toolVersion,
  traceSchemaVersion,
  type BundleManifest,
} from './contracts';
import { encodeBundleJson, parseBundleJson, sha256Hex } from './json';
import { openJournal, readJournal } from './journal';
import {
  projectWorkdir,
  recordedRunMethod,
  type CredentialFinding,
} from './project';
import { redactBundle, type Redactions } from './redact';
import { runJournalDir } from './recorder';
import { acquireWriterLock } from './writer-lock';
import { writeArchive } from './zip';

// ============================================================================
// Finalization and export (specs/aeo-open-source-cli-spec.md §8.2, §9). A
// finalized revision is an immutable directory under REVISIONS/ in the work
// directory; export packs the latest one, or finalizes a descendant when the
// working state has moved on. The manifest holds no export-time field, so
// re-exporting a revision yields the same bundle digest and the same bytes.
// ============================================================================

export const revisionsDir = 'REVISIONS';
const identityFile = 'identity.json';

/** Thrown when export refuses to write an archive (exit code 1). */
export class ExportBlockedError extends Error {
  readonly findings: readonly CredentialFinding[];

  constructor(message: string, findings: readonly CredentialFinding[] = []) {
    super(message);
    this.name = 'ExportBlockedError';
    this.findings = findings;
  }
}

const syncPath = async (target: string): Promise<void> => {
  const handle = await open(target, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeSynced = async (file: string, bytes: Buffer): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });

  const handle = await open(file, 'wx');

  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** The measurement identity is minted once per work directory: a later
 * revision of the same collection keeps it (spec §5). */
const readOrMintIdentity = async (dir: string) => {
  const file = path.join(dir, revisionsDir, identityFile);
  const existing = await readFile(file, 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });

  if (existing !== undefined) {
    const parsed = bundleManifestSchema.shape.run
      .pick({ measurementId: true })
      .parse(JSON.parse(existing));

    return parsed;
  }

  const identity = { measurementId: mintRunId() };

  await writeSynced(file, encodeBundleJson(identity));
  await syncPath(path.dirname(file));

  return identity;
};

export type FinalizedRevision = {
  dir: string;
  manifest: BundleManifest;
};

/** readFinalizedRevisions lists the finalized revisions of a work
 * directory, oldest first (revision ids sort by creation time). */
export const readFinalizedRevisions = async (
  dir: string,
): Promise<FinalizedRevision[]> => {
  const root = path.join(dir, revisionsDir);
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) {
        return [];
      }

      throw err;
    },
  );

  const revisions: FinalizedRevision[] = [];

  for (const entry of entries.filter((item) => item.isDirectory()).sort()) {
    if (entry.name.endsWith('.tmp')) {
      continue;
    }

    const revisionDir = path.join(root, entry.name);
    const text = await readFile(
      path.join(revisionDir, bundlePaths.manifest),
      'utf8',
    );

    revisions.push({
      dir: revisionDir,
      manifest: bundleManifestSchema.parse(parseBundleJson(text)),
    });
  }

  return revisions.sort((left, right) =>
    left.manifest.revision.id < right.manifest.revision.id ? -1 : 1,
  );
};

const sameInventory = (
  manifest: BundleManifest,
  files: ReadonlyMap<string, Buffer>,
): boolean => {
  if (manifest.files.length !== files.size) {
    return false;
  }

  return manifest.files.every((file) => {
    const bytes = files.get(file.path);

    return bytes !== undefined && sha256Hex(bytes) === file.sha256;
  });
};

const mediaTypeOf = (file: string) => {
  return file.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json';
};

export type ExportOptions = {
  /** The run's own credentials: found in any exported file, they block. */
  secrets?: readonly string[];
  /** Accept generic credential-pattern findings (`--accept-findings`). */
  acceptFindings?: boolean;
  now?: () => Date;
};

/**
 * finalizeRevision freezes the work directory's current state as a
 * revision, or returns the latest revision when nothing changed since.
 */
export const finalizeRevision = async (
  dir: string,
  options: ExportOptions = {},
): Promise<FinalizedRevision & { reused: boolean }> => {
  // Never a snapshot of a directory a live writer is changing (spec §8.2).
  const writer = await acquireWriterLock(dir, 'export');

  try {
    return await finalizeLockedRevision(dir, options);
  } finally {
    await writer.release();
  }
};

/** How much of the journal the latest revision froze, when everything
 * appended since is that revision's own revision_finalized event: then the
 * run has not moved on, and its revision is reused as it is. */
const unchangedEventCount = async (
  dir: string,
  latest: FinalizedRevision | undefined,
): Promise<number | undefined> => {
  if (!latest) {
    return undefined;
  }

  const text = await readFile(
    path.join(dir, runJournalDir, 'events.jsonl'),
    'utf8',
  ).catch(() => '');
  const { events } = readJournal(text);
  const { count, head } = latest.manifest.events;
  const sameHead = count === 0 || events[count - 1]?.digest === head;
  const onlyFinalized = events
    .slice(count)
    .every((event) => event.type === 'revision_finalized');

  return sameHead && onlyFinalized ? count : undefined;
};

const finalizeLockedRevision = async (
  dir: string,
  {
    secrets = [],
    acceptFindings = false,
    now = () => new Date(),
  }: ExportOptions,
): Promise<FinalizedRevision & { reused: boolean }> => {
  const journalFile = path.join(dir, runJournalDir, 'events.jsonl');
  const hasJournal = await stat(journalFile).then(
    () => true,
    () => false,
  );
  // Opening the journal quarantines a torn last append before anything is
  // frozen, and is how this revision records its own finalization.
  const journal = hasJournal
    ? await openJournal(path.join(dir, runJournalDir))
    : undefined;
  const latest = (await readFinalizedRevisions(dir)).at(-1);
  const unchangedEvents = await unchangedEventCount(dir, latest);

  // A local run from before methods were frozen does not say what it was
  // made with, so this release cannot state it (method release spec §3.1).
  // A revision the release that ran it finalized is reused as it is, when
  // the run has not moved on since; otherwise that release exports it.
  if ((await recordedRunMethod(dir)).kind === 'before_freeze') {
    if (latest && unchangedEvents !== undefined) {
      return { ...latest, reused: true };
    }

    throw new ExportBlockedError(exportBeforeFreezeMessage(dir));
  }

  const projection = await projectWorkdir(dir, {
    secrets,
    eventLimit: unchangedEvents,
  });
  const runCredentials = projection.findings.filter(
    (finding) => finding.kind === 'run_credential',
  );
  const patterns = projection.findings.filter(
    (finding) => finding.kind === 'credential_pattern',
  );

  if (runCredentials.length > 0) {
    throw new ExportBlockedError(
      `Export blocked: one of this run's own credentials appears in ${runCredentials.map((finding) => finding.path).join(', ')}. Please remove it from the run before exporting; a redacted export is not available yet.`,
      runCredentials,
    );
  }

  if (patterns.length > 0 && !acceptFindings) {
    throw new ExportBlockedError(
      `Export blocked: text that looks like a credential appears in ${patterns.map((finding) => finding.path).join(', ')}. Probed answers often quote example keys; please inspect these files and rerun with --accept-findings if they hold no real credential.`,
      patterns,
    );
  }

  if (latest && sameInventory(latest.manifest, projection.files)) {
    return { ...latest, reused: true };
  }

  const identity = await readOrMintIdentity(dir);
  const revisionId = mintRunId(now().getTime());
  const unsigned: Omit<BundleManifest, 'bundleDigest'> = {
    bundleSchemaVersion,
    traceSchemaVersion,
    canonicalization,
    // The version the numbers were made with, never the installed one's:
    // the verifier recomputes them with exactly that arithmetic.
    calculationVersion: projection.calculationVersion,
    tool: {
      id: toolId,
      version: toolVersion,
      sourceRevision: null,
      distributionDigest: null,
      customBuild: false,
    },
    run: {
      id: projection.inputs.runId,
      kind: 'measurement',
      // As the journal's run_started declared it; a directory without a
      // journal is a historical artifact (spec §13, Phase 1).
      origin: projection.journal.origin,
      captureAuthenticity: 'self_reported',
      measurementId: identity.measurementId,
      reportKey: projection.inputs.reportKey,
      execution: projection.execution,
      needsImprovement: projection.needsImprovement,
      ...(projection.derivedFrom && {
        derivedFrom: {
          kind: projection.derivedFrom.kind,
          runId: projection.derivedFrom.runId,
          revisionId: projection.derivedFrom.revisionId,
          bundleDigest: projection.derivedFrom.bundleDigest,
        },
      }),
    },
    revision: {
      id: revisionId,
      finalizedAt: now().toISOString(),
      predecessor: latest
        ? {
            id: latest.manifest.revision.id,
            bundleDigest: latest.manifest.bundleDigest,
          }
        : null,
    },
    digests: projection.digests,
    files: [...projection.files.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([file, bytes]) => ({
        path: file,
        bytes: bytes.length,
        mediaType: mediaTypeOf(file),
        sha256: sha256Hex(bytes),
      })),
    events: projection.journal.events,
    trace: projection.journal.trace,
    acceptedFindings: patterns.map((finding) => ({
      path: finding.path,
      kind: 'credential_pattern' as const,
    })),
  };
  const manifest = bundleManifestSchema.parse({
    ...unsigned,
    bundleDigest: digestManifest(unsigned),
  });

  const root = path.join(dir, revisionsDir);
  const staging = path.join(root, `${revisionId}.tmp`);
  const target = path.join(root, revisionId);

  await rm(staging, { recursive: true, force: true });

  for (const [file, bytes] of projection.files) {
    await writeSynced(path.join(staging, file), bytes);
  }

  await writeSynced(
    path.join(staging, bundlePaths.manifest),
    encodeBundleJson(manifest),
  );
  await rename(staging, target);
  await syncPath(root);
  // After the prefix it freezes, so later revisions carry this one's lineage
  // without a hash cycle (spec §7.3).
  await journal?.append({
    type: 'revision_finalized',
    payload: {
      revisionId,
      eventCount: manifest.events.count,
      head: manifest.events.head,
      bundleDigest: manifest.bundleDigest,
    },
  });

  return { dir: target, manifest, reused: false };
};

/** The bundle files of a finalized revision directory, manifest included. */
export const readRevisionFiles = async (
  revision: FinalizedRevision,
): Promise<Map<string, Buffer>> => {
  const files = new Map<string, Buffer>();

  for (const file of [
    bundlePaths.manifest,
    ...revision.manifest.files.map((entry) => entry.path),
  ]) {
    files.set(file, await readFile(path.join(revision.dir, file)));
  }

  return files;
};

export type ExportResult = {
  archive: string;
  archiveSha256: string;
  manifest: BundleManifest;
  reusedRevision: boolean;
};

/**
 * exportRun packs the work directory's latest finalized revision into a
 * new .aeo.zip archive. It never overwrites an existing archive.
 */
export const exportRun = async (
  dir: string,
  {
    output,
    redactions,
    ...options
  }: ExportOptions & { output?: string; redactions?: Redactions } = {},
): Promise<ExportResult> => {
  const suffix = redactions ? '.redacted.aeo.zip' : '.aeo.zip';
  const archive = path.resolve(output ?? `${path.resolve(dir)}${suffix}`);
  const exists = await open(archive, 'r').then(
    async (handle) => {
      await handle.close();

      return true;
    },
    () => false,
  );

  if (exists) {
    throw new ExportBlockedError(
      `Please choose another --output: ${archive} already exists and export never overwrites an archive.`,
    );
  }

  const revision = await finalizeRevision(dir, options);
  const full = await readRevisionFiles(revision);
  // A redacted derivative is an export, never a revision of the run: the
  // finalized original stays as it is (spec §9).
  const files = redactions
    ? redactBundle(full, revision.manifest, redactions)
    : full;
  const manifest = redactions
    ? bundleManifestSchema.parse(
        parseBundleJson(
          files.get(bundlePaths.manifest)?.toString('utf8') ?? '',
        ),
      )
    : revision.manifest;
  const bytes = writeArchive(
    [...files.entries()].map(([file, content]) => ({
      path: file,
      bytes: content,
    })),
  );

  await writeSynced(archive, bytes);

  const result: ExportResult = {
    archive,
    archiveSha256: sha256Hex(bytes),
    manifest,
    reusedRevision: revision.reused,
  };

  return result;
};
