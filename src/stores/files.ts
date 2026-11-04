import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import {
  domainLabelsFile,
  domainLabelsFileSchema,
  type DomainLabelsFile,
} from '../analysis/domain-labels';
import { projectProgressMeasurement } from '../analysis/progress';
import { parseProgressMeasurement } from '../analysis/progress-schema';
import { entryMatches, unitRecordKey } from '../lib/checkpoint';
import { createLog } from '../lib/log';
import { aeoCheckpointDir, aeoContentDir } from '../lib/paths';
import type { ProgressMeasurement } from '../lib/progress-comparison';
import {
  aeoAuditConfigSchema,
  aeoEvidenceChunkSchema,
  aeoSnapshotSchema,
  evidenceChunkFileName,
  type AeoEvidenceChunk,
  type AeoSnapshot,
} from '../schema';
import { validateReportArtifacts } from './artifacts';
import { contentHash } from './content-hash';
import {
  filePublicationHistory,
  readFilePublication,
  withFilePublicationLock,
  writeAtomicJson,
  writeFilePublication,
} from './file-publication';
import { hasErrorCode } from './fs-errors';
import { openFileVersionStores } from './local-versions';
import type { AnalysisEntry } from './memory';
import {
  UnitConflictError,
  type AnalysisEntryMeta,
  type AnalysisStore,
  type CapturedUnitRecord,
  type CheckpointMatch,
  type FailedUnitRecord,
  type ProbeStore,
  type ProbeUnit,
  type ReportArtifacts,
  type ReportStore,
  type RunClaim,
  type RunClaimResult,
  type RunReconciliation,
  type RunRecord,
  type RunStore,
  type Stores,
  type UnitRecord,
} from './ports';
import {
  assertPublishable,
  sameTriple,
  type PublicationTriple,
  type PublishReceipt,
} from './publication';
import { publicationTripleSchema } from './publication-history';
import {
  evaluateRunClaim,
  isTerminalRun,
  serializeRunFile,
} from './run-lifecycle';
import {
  StoreConflictError,
  type ConfigStore,
  type CopyStore,
} from './versions';

const log = createLog('FileStores');

// ============================================================================
// File-backed implementations of the storage ports — the interim backend
// (hardening spec §4.4) until the Postgres stores take over. Probe and
// analysis records are append-only JSONL under aeo/checkpoints/ (crash-safe:
// a torn tail line is skipped on load; gitignored: entries carry raw client
// answers). Reports are the committed content/aeo-insights/<reportKey>/
// layout (snapshot.json, domain-labels.json, evidence/), written atomically
// through a temp directory. A write failure rejects — never swallowed.
// ============================================================================

type JsonlLine = {
  key: string;
  value: unknown;
};

const readJsonl = async (filePath: string): Promise<unknown[]> => {
  let raw: string;

  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const rows: unknown[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      rows.push(JSON.parse(line));
    } catch {
      // Torn tail line from an interrupted append — the unit it held simply
      // reruns.
    }
  }

  return rows;
};

// Appends are chained so parallel completions never interleave lines.
class JsonlFile {
  readonly filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(line: string): Promise<void> {
    return this.#write(`${line}\n`, 'a');
  }

  rewrite(lines: string[]): Promise<void> {
    return this.#write(lines.map((line) => `${line}\n`).join(''), 'w');
  }

  #write(content: string, flag: 'a' | 'w'): Promise<void> {
    const write = this.#queue.then(async () => {
      const directory = path.dirname(this.filePath);

      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);

      const file = await open(this.filePath, flag, 0o600);

      try {
        // Existing checkpoints may predate private diagnostics. Restrict the
        // opened file before writing any further customer evidence.
        await file.chmod(0o600);
        await file.writeFile(content, 'utf8');
      } finally {
        await file.close();
      }
    });

    // The chain must survive a rejected write; the caller still sees it.
    this.#queue = write.catch(() => undefined);

    return write;
  }
}

// The stored probe payload is trusted as written by put(); a line is only
// checked for the unit key and its outcome fields.
const hasUnitKey = (row: object): row is ProbeUnit => {
  return (
    'sectionKey' in row &&
    typeof row.sectionKey === 'string' &&
    'promptId' in row &&
    typeof row.promptId === 'string' &&
    'promptText' in row &&
    typeof row.promptText === 'string' &&
    'surface' in row &&
    typeof row.surface === 'string' &&
    'runIndex' in row &&
    typeof row.runIndex === 'number'
  );
};

const isFailedUnitLine = (row: ProbeUnit): row is FailedUnitRecord => {
  return 'status' in row && row.status === 'failed';
};

const isCapturedUnitLine = (
  row: ProbeUnit,
): row is Omit<CapturedUnitRecord, 'status'> => {
  return (
    'probe' in row &&
    Boolean(row.probe) &&
    'capturedAt' in row &&
    typeof row.capturedAt === 'string'
  );
};

// Stored line shape: the record as-is. Lines written before unit outcomes
// existed carry no `status`; they are captured records.
const parseUnitRecord = (row: unknown): UnitRecord | null => {
  if (!row || typeof row !== 'object' || !hasUnitKey(row)) {
    return null;
  }

  if (isFailedUnitLine(row)) {
    return row;
  }

  if (isCapturedUnitLine(row)) {
    return { ...row, status: 'captured' };
  }

  return null;
};

export class FileProbeStore implements ProbeStore {
  readonly #file: JsonlFile;
  readonly #records: Map<string, UnitRecord>;

  private constructor(filePath: string, records: Map<string, UnitRecord>) {
    this.#file = new JsonlFile(filePath);
    this.#records = records;
  }

  static async open(
    reportKey: string,
    opts: { dir?: string } = {},
  ): Promise<FileProbeStore> {
    const filePath = path.join(
      opts.dir ?? aeoCheckpointDir,
      `${reportKey}.jsonl`,
    );
    const records = new Map<string, UnitRecord>();

    for (const row of await readJsonl(filePath)) {
      const record = parseUnitRecord(row);

      // Last line wins on load — the file is a log of writes.
      if (record) {
        records.set(unitRecordKey(record), record);
      }
    }

    return new FileProbeStore(filePath, records);
  }

  get size(): number {
    return this.#records.size;
  }

  get(unit: ProbeUnit): Promise<UnitRecord | null> {
    return Promise.resolve(this.#records.get(unitRecordKey(unit)) ?? null);
  }

  async put(record: UnitRecord): Promise<void> {
    const key = unitRecordKey(record);
    const existing = this.#records.get(key);

    if (existing?.status === 'captured') {
      // A capture is the record of value: a second capture is refused and
      // a later failure never erases it (same rule as the Postgres store).
      if (record.status === 'captured') {
        throw new UnitConflictError(key);
      }

      return;
    }

    this.#records.set(key, record);

    await this.#file.append(JSON.stringify(record));
  }

  async invalidate(match: CheckpointMatch): Promise<number> {
    let removed = 0;

    for (const [key, record] of this.#records) {
      if (!entryMatches(record, match)) {
        continue;
      }

      this.#records.delete(key);
      removed += 1;
    }

    if (removed > 0) {
      await this.#rewrite();
    }

    return removed;
  }

  list(): Promise<UnitRecord[]> {
    return Promise.resolve([...this.#records.values()]);
  }

  /**
   * rewriteRecords rewrites stored probes in place (one-off data repairs):
   * `patch` returns the replacement record or null to leave the entry
   * untouched.
   */
  async rewriteRecords(
    patch: (record: UnitRecord) => UnitRecord | null,
  ): Promise<number> {
    let changed = 0;

    for (const [key, record] of this.#records) {
      const next = patch(record);

      if (!next) {
        continue;
      }

      this.#records.set(key, next);
      changed += 1;
    }

    if (changed > 0) {
      await this.#rewrite();
    }

    return changed;
  }

  #rewrite(): Promise<void> {
    return this.#file.rewrite(
      [...this.#records.values()].map((record) => JSON.stringify(record)),
    );
  }
}

export const analysisCheckpointPath = (
  reportKey: string,
  dir: string = aeoCheckpointDir,
): string => {
  return path.join(dir, `${reportKey}.analysis.jsonl`);
};

const isAnalysisEntryLine = (row: unknown): row is AnalysisEntry => {
  return (
    typeof row === 'object' &&
    row !== null &&
    'key' in row &&
    typeof row.key === 'string' &&
    'value' in row
  );
};

export class FileAnalysisStore implements AnalysisStore {
  readonly #file: JsonlFile;
  readonly #entries: Map<string, AnalysisEntry>;

  private constructor(filePath: string, entries: Map<string, AnalysisEntry>) {
    this.#file = new JsonlFile(filePath);
    this.#entries = entries;
  }

  static async open(
    reportKey: string,
    opts: { dir?: string } = {},
  ): Promise<FileAnalysisStore> {
    const filePath = analysisCheckpointPath(reportKey, opts.dir);
    const entries = new Map<string, AnalysisEntry>();

    for (const row of await readJsonl(filePath)) {
      if (isAnalysisEntryLine(row)) {
        entries.set(row.key, row);
      }
    }

    return new FileAnalysisStore(filePath, entries);
  }

  get<T>(key: string, schema: ZodType<T>): Promise<T | null> {
    const entry = this.#entries.get(key);

    if (!entry) {
      return Promise.resolve(null);
    }

    const parsed = schema.safeParse(entry.value);

    if (!parsed.success) {
      log.warn('Ignoring invalid cached analysis entry', {
        key: key.slice(0, 80),
        error: parsed.error.message.slice(0, 200),
      });

      return Promise.resolve(null);
    }

    return Promise.resolve(parsed.data);
  }

  async put(
    key: string,
    value: unknown,
    meta?: AnalysisEntryMeta,
  ): Promise<void> {
    const entry: AnalysisEntry = {
      key,
      storedAt: new Date().toISOString(),
      value,
      ...(meta ? { meta } : {}),
    };

    this.#entries.set(key, entry);

    await this.#file.append(JSON.stringify(entry));
  }

  async clear(): Promise<number> {
    const size = this.#entries.size;

    this.#entries.clear();

    await rm(this.#file.filePath, { force: true });

    return size;
  }

  count(): Promise<number> {
    return Promise.resolve(this.#entries.size);
  }
}

const publishedPointerSchema = z.object({ runId: z.string() });

// Fields are compared, not trusted: a mismatch is a conflict. zod requires a
// `z.unknown()` key to be present, so each one is marked optional.
const storedProgressSchema = z.object({
  reportKey: z.unknown().optional(),
  configVersion: z.unknown().optional(),
  sourceDigest: z.unknown().optional(),
  measurement: z.unknown().optional(),
});

// Only what publication checks; a missing or malformed field fails those
// checks as a conflict rather than as a parse error. An ungrounded run omits
// the grounding and captureManifest keys from artifacts.json.
const storedArtifactSchema = z.object({
  fullScope: z.boolean().catch(false),
  configVersion: z.number().nullish().catch(null),
  snapshot: z.unknown().optional(),
  grounding: z.unknown().optional(),
  captureManifest: z.unknown().optional(),
});

type StoredArtifact = z.infer<typeof storedArtifactSchema>;

type PublicationStores = {
  configStore: ConfigStore;
  copyStore: CopyStore;
  runStore: RunStore;
};

type ProgressSource = {
  config: unknown;
  artifact: StoredArtifact;
};

export class FileReportStore implements ReportStore {
  readonly contentDir: string;
  readonly #publicationStores: PublicationStores | undefined;

  constructor(
    contentDir: string = aeoContentDir,
    publicationStores?: PublicationStores,
  ) {
    this.contentDir = contentDir;
    this.#publicationStores = publicationStores;
  }

  #runDir(reportKey: string, runId: string): string {
    for (const value of [reportKey, runId]) {
      if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
        throw new Error(`Invalid report or run identity provided: ${value}.`);
      }
    }

    const runsDir =
      this.contentDir === aeoContentDir
        ? path.join(aeoCheckpointDir, 'reports')
        : path.join(this.contentDir, '.runs');

    return path.join(runsDir, reportKey, runId);
  }

  async #readableDir(reportKey: string, runId?: string): Promise<string> {
    if (runId) {
      return this.#runDir(reportKey, runId);
    }

    try {
      const publication = publishedPointerSchema.parse(
        JSON.parse(
          await readFile(
            path.join(this.reportDir(reportKey), 'published.json'),
            'utf8',
          ),
        ),
      );

      return this.#runDir(reportKey, publication.runId);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }

      return this.reportDir(reportKey);
    }
  }

  reportDir(reportKey: string): string {
    return path.join(this.contentDir, reportKey);
  }

  async readArtifacts(
    reportKey: string,
    runId: string,
  ): Promise<ReportArtifacts | null> {
    try {
      return validateReportArtifacts(
        JSON.parse(
          await readFile(
            path.join(this.#runDir(reportKey, runId), 'artifacts.json'),
            'utf8',
          ),
        ),
        reportKey,
        runId,
      );
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return null;
      }

      throw error;
    }
  }

  /** readProgressArtifacts serves the server-side history projection, which
   * validates its envelope and capture metadata separately so corrupt old
   * provenance becomes an invalid chart point. */
  async readProgressArtifacts(
    reportKey: string,
    runId: string,
  ): Promise<unknown> {
    try {
      const artifacts: unknown = JSON.parse(
        await readFile(
          path.join(this.#runDir(reportKey, runId), 'artifacts.json'),
          'utf8',
        ),
      );

      return artifacts;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return null;
      }

      throw error;
    }
  }

  async readProgressMeasurement(
    reportKey: string,
    runId: string,
    configVersion: number,
  ): Promise<ProgressMeasurement | null> {
    try {
      const value = storedProgressSchema.parse(
        JSON.parse(
          await readFile(
            path.join(this.#runDir(reportKey, runId), 'progress.json'),
            'utf8',
          ),
        ),
      );

      if (
        value.reportKey !== reportKey ||
        value.configVersion !== configVersion
      ) {
        throw new StoreConflictError(
          `Stored progress projection of run ${runId} belongs to another report or config.`,
        );
      }

      return parseProgressMeasurement(value.measurement, runId);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return null;
      }

      throw error;
    }
  }

  async #freezeProgressMeasurement(
    { reportKey, runId }: PublicationTriple,
    { config, artifact }: ProgressSource,
  ): Promise<void> {
    const directory = this.#runDir(reportKey, runId);
    const sourceDigest = contentHash({
      config,
      snapshot: artifact.snapshot,
      captureManifest: artifact.captureManifest ?? null,
    });

    try {
      const existing = storedProgressSchema.parse(
        JSON.parse(
          await readFile(path.join(directory, 'progress.json'), 'utf8'),
        ),
      );

      parseProgressMeasurement(existing.measurement, runId);

      if (
        existing.reportKey !== reportKey ||
        existing.configVersion !== artifact.configVersion ||
        existing.sourceDigest !== sourceDigest
      ) {
        throw new StoreConflictError(
          `Stored progress projection of run ${runId} has a different immutable source.`,
        );
      }

      return;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }

    const measurement = parseProgressMeasurement(
      projectProgressMeasurement({
        runId,
        config: aeoAuditConfigSchema.parse(config),
        snapshot: aeoSnapshotSchema.parse(artifact.snapshot),
        captureManifest: artifact.captureManifest,
      }),
      runId,
    );

    await writeAtomicJson(directory, 'progress.json', {
      reportKey,
      configVersion: artifact.configVersion,
      sourceDigest,
      measurement,
    });
  }

  async readSnapshot(
    reportKey: string,
    runId?: string,
  ): Promise<AeoSnapshot | null> {
    const filePath = path.join(
      await this.#readableDir(reportKey, runId),
      'snapshot.json',
    );

    if (!existsSync(filePath)) {
      return null;
    }

    const snapshot = aeoSnapshotSchema.parse(
      JSON.parse(await readFile(filePath, 'utf8')),
    );

    if (snapshot.reportKey !== reportKey) {
      throw new Error(
        `${filePath} belongs to report '${snapshot.reportKey}', not '${reportKey}'.`,
      );
    }

    return snapshot;
  }

  async readLabels(
    reportKey: string,
    runId?: string,
  ): Promise<DomainLabelsFile | null> {
    const filePath = path.join(
      await this.#readableDir(reportKey, runId),
      domainLabelsFile,
    );

    if (!existsSync(filePath)) {
      return null;
    }

    // An unparseable committed labels file is a defect, never a silent
    // re-classification (§2.10).
    const labels = domainLabelsFileSchema.parse(
      JSON.parse(await readFile(filePath, 'utf8')),
    );

    return labels;
  }

  async readEvidenceChunk(
    reportKey: string,
    runIdOrFile: string,
    requestedFile?: string,
  ): Promise<AeoEvidenceChunk> {
    const file = requestedFile ?? runIdOrFile;

    if (!/^evidence\/[a-zA-Z0-9_-]+-\d+\.json$/.test(file)) {
      throw new Error(`Invalid evidence file provided: ${file}.`);
    }

    const filePath = path.join(
      await this.#readableDir(
        reportKey,
        requestedFile ? runIdOrFile : undefined,
      ),
      file,
    );

    const chunk = aeoEvidenceChunkSchema.parse(
      JSON.parse(await readFile(filePath, 'utf8')),
    );

    return chunk;
  }

  /** writeReport saves an immutable run in a private directory; publication
   * is explicit. */
  async writeReport(
    reportKey: string,
    runId: string,
    artifacts: ReportArtifacts,
  ): Promise<void> {
    validateReportArtifacts(artifacts, reportKey, runId);

    if (artifacts.snapshot.reportKey !== reportKey) {
      throw new StoreConflictError(
        `Snapshot belongs to another report than ${reportKey}.`,
      );
    }

    const targetDir = this.#runDir(reportKey, runId);

    if (existsSync(targetDir)) {
      const existing: unknown = JSON.parse(
        await readFile(path.join(targetDir, 'artifacts.json'), 'utf8'),
      );

      if (JSON.stringify(existing) !== JSON.stringify(artifacts)) {
        throw new StoreConflictError(
          `Run artifacts are immutable: ${reportKey}/${runId}.`,
        );
      }

      return;
    }

    await mkdir(this.contentDir, { recursive: true });

    const tempDir = await mkdtemp(path.join(this.contentDir, '.tmp-'));

    try {
      await mkdir(path.join(tempDir, 'evidence'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'snapshot.json'),
        `${JSON.stringify(artifacts.snapshot, null, 2)}\n`,
        'utf8',
      );
      await writeFile(
        path.join(tempDir, domainLabelsFile),
        `${JSON.stringify(artifacts.labels, null, 2)}\n`,
        'utf8',
      );

      for (const chunk of artifacts.chunks) {
        await writeFile(
          path.join(
            tempDir,
            evidenceChunkFileName(chunk.sectionKey, chunk.promptIdx),
          ),
          JSON.stringify(chunk),
          'utf8',
        );
      }

      await writeFile(
        path.join(tempDir, 'artifacts.json'),
        JSON.stringify(artifacts),
        'utf8',
      );
      await mkdir(path.dirname(targetDir), { recursive: true });
      await rename(tempDir, targetDir);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });

      throw error;
    }
  }

  async publish(
    requested: PublicationTriple,
    receipt: PublishReceipt,
  ): Promise<void> {
    const triple = publicationTripleSchema.parse({
      reportKey: requested.reportKey,
      runId: requested.runId,
      configVersion: requested.configVersion,
      copyVersion: requested.copyVersion,
    });
    const { reportKey, runId, configVersion, copyVersion } = triple;
    const directory = this.reportDir(reportKey);

    await withFilePublicationLock(directory, async () => {
      const previous = await readFilePublication(directory, reportKey);

      if (previous && sameTriple(previous, triple)) {
        return;
      }

      const stores = this.#publicationStores ?? {
        ...openFileVersionStores(),
        runStore: new FileRunStore(),
      };
      const [storedConfig, storedCopy, storedRun] = await Promise.all([
        stores.configStore.getVersion(reportKey, configVersion),
        stores.copyStore.getVersion(reportKey, copyVersion),
        stores.runStore.get(runId),
      ]);
      const storedArtifact = storedArtifactSchema.parse(
        JSON.parse(
          await readFile(
            path.join(this.#runDir(reportKey, runId), 'artifacts.json'),
            'utf8',
          ),
        ),
      );

      const { config, artifact } = assertPublishable({
        triple,
        receipt,
        priorPublication: previous?.history?.find((entry) =>
          sameTriple(entry, triple),
        ),
        config: storedConfig,
        copy: storedCopy,
        run: storedRun,
        artifact: storedArtifact,
      });

      const now = new Date().toISOString();

      // A failed pointer commit may leave this private cache, but cannot publish it.
      await this.#freezeProgressMeasurement(triple, {
        config: config.config,
        artifact,
      });

      const history = previous ? filePublicationHistory(previous, now) : [];

      if (previous?.history === undefined) {
        await this.#assertLegacyPublication(stores, previous);
      }

      if (!history.some((entry) => sameTriple(entry, triple))) {
        history.push({
          ...triple,
          firstPublishedAt: now,
          recordedAt: now,
          origin: 'publication',
        });
      }

      await writeFilePublication(directory, { ...receipt, history });
    });
  }

  // A pointer written before history existed must still point at a valid,
  // approved publication before its backfilled history is trusted.
  async #assertLegacyPublication(
    stores: PublicationStores,
    previous: PublicationTriple | null,
  ): Promise<void> {
    if (!previous) {
      return;
    }

    const { reportKey } = previous;
    const [oldArtifact, oldConfig, oldCopy] = await Promise.all([
      this.readArtifacts(reportKey, previous.runId),
      stores.configStore.getVersion(reportKey, previous.configVersion),
      stores.copyStore.getVersion(reportKey, previous.copyVersion),
    ]);

    if (
      !oldArtifact?.fullScope ||
      oldArtifact.configVersion !== previous.configVersion ||
      oldConfig?.config.reportKey !== reportKey ||
      oldCopy?.copy.reportKey !== reportKey ||
      !['approved', 'superseded'].includes(oldConfig.status) ||
      !['approved', 'superseded'].includes(oldCopy.status)
    ) {
      throw new StoreConflictError(
        `Existing file publication of ${reportKey} cannot establish valid history.`,
      );
    }
  }

  /** rewriteReport rewrites the snapshot and labels of an existing report in
   * place. */
  async rewriteReport(
    reportKey: string,
    artifacts: Pick<ReportArtifacts, 'snapshot' | 'labels'>,
  ): Promise<void> {
    const dir = this.reportDir(reportKey);

    // Labels first: a crash between the two writes leaves a snapshot the
    // next run rebuilds from the labels, never the reverse.
    await writeFile(
      path.join(dir, domainLabelsFile),
      `${JSON.stringify(artifacts.labels, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(dir, 'snapshot.json'),
      `${JSON.stringify(artifacts.snapshot, null, 2)}\n`,
      'utf8',
    );
  }

  async listReportKeys(): Promise<string[]> {
    if (!existsSync(this.contentDir)) {
      return [];
    }

    const entries = await readdir(this.contentDir, { withFileTypes: true });
    const reportKeys = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();

    return reportKeys;
  }
}

// Lines are written only by this store, from typed records.
const isRunRecordLine = (row: unknown): row is RunRecord => {
  return (
    typeof row === 'object' &&
    row !== null &&
    'runId' in row &&
    typeof row.runId === 'string'
  );
};

export class FileRunStore implements RunStore {
  readonly #file: JsonlFile;

  constructor(dir: string = aeoCheckpointDir) {
    this.#file = new JsonlFile(path.join(dir, 'runs.jsonl'));
  }

  async start(record: RunRecord): Promise<void> {
    await serializeRunFile(this.#file.filePath, async () => {
      if (!(await this.get(record.runId))) {
        await this.#file.append(JSON.stringify(record));
      }
    });
  }

  async claim(runId: string, claim: RunClaim): Promise<RunClaimResult> {
    return serializeRunFile(this.#file.filePath, async () => {
      const result = evaluateRunClaim(await this.get(runId), claim);

      if (result.status === 'claimed') {
        await this.#file.append(JSON.stringify(result.record));
      }

      return result;
    });
  }

  async reconcile(
    runId: string,
    outcome: RunReconciliation,
    claim: RunClaim,
  ): Promise<boolean> {
    return serializeRunFile(this.#file.filePath, async () => {
      const record = await this.get(runId);

      if (
        !record ||
        isTerminalRun(record) ||
        record.batchJobId !== claim.batchJobId ||
        record.batchAttempt !== claim.attempt
      ) {
        return false;
      }

      await this.#file.append(JSON.stringify({ ...record, ...outcome }));

      return true;
    });
  }

  async finish(
    runId: string,
    outcome: Pick<RunRecord, 'status' | 'finishedAt' | 'partialFailures'> &
      Partial<Pick<RunRecord, 'logLocation'>>,
  ): Promise<void> {
    await serializeRunFile(this.#file.filePath, async () => {
      const existing = await this.get(runId);

      if (!existing) {
        throw new Error(`Unknown run: ${runId}.`);
      }

      if (isTerminalRun(existing)) {
        return;
      }

      await this.#file.append(JSON.stringify({ ...existing, ...outcome }));
    });
  }

  async get(runId: string): Promise<RunRecord | null> {
    let found: RunRecord | null = null;

    for (const row of await readJsonl(this.#file.filePath)) {
      if (isRunRecordLine(row) && row.runId === runId) {
        found = row;
      }
    }

    return found;
  }
}

export const openFileStores = async (
  reportKey: string,
  opts: { checkpointDir?: string; contentDir?: string } = {},
): Promise<
  Stores & {
    probeStore: FileProbeStore;
    analysisStore: FileAnalysisStore;
    reportStore: FileReportStore;
  }
> => {
  const stores = {
    probeStore: await FileProbeStore.open(reportKey, {
      dir: opts.checkpointDir,
    }),
    analysisStore: await FileAnalysisStore.open(reportKey, {
      dir: opts.checkpointDir,
    }),
    reportStore: new FileReportStore(opts.contentDir),
    runStore: new FileRunStore(opts.checkpointDir),
  };

  return stores;
};

export type { JsonlLine };
