import type { ZodType } from 'zod';
import {
  evidenceChunkFileName,
  type AeoEvidenceChunk,
  type AeoSnapshot,
} from '../schema';
import type { DomainLabelsFile } from '../analysis/domain-labels';
import { entryMatches, unitRecordKey } from '../lib/checkpoint';
import {
  assertPublishable,
  type PublicationTriple,
  type PublishReceipt,
} from './publication';
import {
  StoreConflictError,
  type ConfigStore,
  type CopyStore,
} from './versions';
import { memoryVersionStores } from './local-versions';
import { evaluateRunClaim, isTerminalRun } from './run-lifecycle';
import {
  type RunClaim,
  type RunClaimResult,
  type RunReconciliation,
  UnitConflictError,
  type AnalysisEntryMeta,
  type AnalysisStore,
  type CheckpointMatch,
  type ProbeStore,
  type ProbeUnit,
  type ReportArtifacts,
  type ReportStore,
  type RunRecord,
  type RunStore,
  type Stores,
  type UnitRecord,
} from './ports';
import { validateReportArtifacts } from './artifacts';

// ============================================================================
// Map-backed implementations of the storage ports — for unit tests and the
// golden replay (hardening spec §4.4, §6.1). Same semantics as the durable
// backends: conditional unit writes, invalid cached values are misses,
// snapshot reads assert the report key.
// ============================================================================

// Runs synchronous store work as a promise, so a throw becomes a rejection as
// it does in the durable stores.
const settle = <T>(work: () => T): Promise<T> => {
  return new Promise<T>((resolve) => {
    resolve(work());
  });
};

export class MemoryProbeStore implements ProbeStore {
  readonly #records = new Map<string, UnitRecord>();

  constructor(seed: Iterable<UnitRecord> = []) {
    for (const record of seed) {
      this.#records.set(unitRecordKey(record), record);
    }
  }

  get(unit: ProbeUnit): Promise<UnitRecord | null> {
    return Promise.resolve(this.#records.get(unitRecordKey(unit)) ?? null);
  }

  put(record: UnitRecord): Promise<void> {
    return settle(() => {
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
    });
  }

  invalidate(match: CheckpointMatch): Promise<number> {
    let removed = 0;

    for (const [key, record] of this.#records) {
      if (!entryMatches(record, match)) {
        continue;
      }

      this.#records.delete(key);
      removed += 1;
    }

    return Promise.resolve(removed);
  }

  list(): Promise<UnitRecord[]> {
    return Promise.resolve([...this.#records.values()]);
  }
}

export type AnalysisEntry = {
  key: string;
  storedAt: string;
  value: unknown;
  meta?: AnalysisEntryMeta;
};

export class MemoryAnalysisStore implements AnalysisStore {
  readonly #entries = new Map<string, AnalysisEntry>();

  constructor(seed: Iterable<AnalysisEntry> = []) {
    for (const entry of seed) {
      this.#entries.set(entry.key, entry);
    }
  }

  get<T>(key: string, schema: ZodType<T>): Promise<T | null> {
    const entry = this.#entries.get(key);

    if (!entry) {
      return Promise.resolve(null);
    }

    const parsed = schema.safeParse(entry.value);

    return Promise.resolve(parsed.success ? parsed.data : null);
  }

  put(key: string, value: unknown, meta?: AnalysisEntryMeta): Promise<void> {
    this.#entries.set(key, {
      key,
      storedAt: new Date().toISOString(),
      value,
      ...(meta ? { meta } : {}),
    });

    return Promise.resolve();
  }

  clear(): Promise<number> {
    const size = this.#entries.size;

    this.#entries.clear();

    return Promise.resolve(size);
  }

  count(): Promise<number> {
    return Promise.resolve(this.#entries.size);
  }
}

export type MemoryReport = {
  runId: string;
  snapshot: AeoSnapshot | null;
  labels: DomainLabelsFile | null;
  chunks: AeoEvidenceChunk[];
};

type PublicationStores = {
  configStore: ConfigStore;
  copyStore: CopyStore;
  runStore: RunStore;
};

export class MemoryReportStore implements ReportStore {
  readonly reports = new Map<string, MemoryReport>();
  readonly artifacts = new Map<string, ReportArtifacts>();
  readonly #published = new Map<string, string>();
  readonly #seeded = new Map<string, MemoryReport>();
  readonly #publicationStores: PublicationStores | undefined;

  constructor(
    seed: Iterable<Partial<MemoryReport> & { reportKey: string }> = [],
    publicationStores?: PublicationStores,
  ) {
    this.#publicationStores = publicationStores;

    for (const report of seed) {
      const value = {
        runId: report.runId ?? 'seed',
        snapshot: report.snapshot ?? null,
        labels: report.labels ?? null,
        chunks: report.chunks ?? [],
      };

      this.reports.set(report.reportKey, value);
      this.#seeded.set(report.reportKey, structuredClone(value));
      this.#published.set(report.reportKey, value.runId);
    }
  }

  // The stored run artifact, or else the seeded report when it is that run.
  #resolve(
    reportKey: string,
    runId: string | undefined,
  ): { artifact: ReportArtifacts | undefined; seed: MemoryReport | undefined } {
    const artifact = runId
      ? this.artifacts.get(`${reportKey}/${runId}`)
      : undefined;
    const seeded = this.#seeded.get(reportKey);
    const seed = seeded?.runId === runId ? seeded : undefined;

    return { artifact, seed };
  }

  readArtifacts(
    reportKey: string,
    runId: string,
  ): Promise<ReportArtifacts | null> {
    return settle(() => {
      const artifacts = this.artifacts.get(`${reportKey}/${runId}`);

      return artifacts
        ? validateReportArtifacts(structuredClone(artifacts), reportKey, runId)
        : null;
    });
  }

  readSnapshot(
    reportKey: string,
    requestedRunId?: string,
  ): Promise<AeoSnapshot | null> {
    return settle(() => {
      const runId = requestedRunId ?? this.#published.get(reportKey);
      const { artifact, seed } = this.#resolve(reportKey, runId);
      const snapshot = artifact?.snapshot ?? seed?.snapshot ?? null;

      if (snapshot && snapshot.reportKey !== reportKey) {
        throw new StoreConflictError(
          `Snapshot stored under '${reportKey}' belongs to '${snapshot.reportKey}'`,
        );
      }

      return snapshot;
    });
  }

  readLabels(
    reportKey: string,
    requestedRunId?: string,
  ): Promise<DomainLabelsFile | null> {
    const runId = requestedRunId ?? this.#published.get(reportKey);
    const { artifact, seed } = this.#resolve(reportKey, runId);

    return Promise.resolve(artifact?.labels ?? seed?.labels ?? null);
  }

  readEvidenceChunk(
    reportKey: string,
    runIdOrFile: string,
    requestedFile?: string,
  ): Promise<AeoEvidenceChunk> {
    return settle(() => {
      const runId = requestedFile
        ? runIdOrFile
        : this.#published.get(reportKey);
      const file = requestedFile ?? runIdOrFile;
      const { artifact, seed } = this.#resolve(reportKey, runId);
      const chunks = artifact?.chunks ?? seed?.chunks ?? [];
      const chunk = chunks.find(
        (candidate) =>
          evidenceChunkFileName(candidate.sectionKey, candidate.promptIdx) ===
          file,
      );

      if (!chunk) {
        throw new Error(`No evidence chunk '${file}' for ${reportKey}.`);
      }

      return chunk;
    });
  }

  writeReport(
    reportKey: string,
    runId: string,
    artifacts: ReportArtifacts,
  ): Promise<void> {
    return settle(() => {
      validateReportArtifacts(artifacts, reportKey, runId);

      if (artifacts.snapshot.reportKey !== reportKey) {
        throw new StoreConflictError('Snapshot belongs to another report');
      }

      const key = `${reportKey}/${runId}`;
      const existing = this.artifacts.get(key);

      if (existing && JSON.stringify(existing) !== JSON.stringify(artifacts)) {
        throw new StoreConflictError('Run artifacts are immutable');
      }

      this.artifacts.set(key, structuredClone(artifacts));
      this.reports.set(reportKey, { runId, ...structuredClone(artifacts) });
    });
  }

  async publish(
    triple: PublicationTriple,
    receipt: PublishReceipt,
  ): Promise<void> {
    if (!this.#publicationStores) {
      throw new StoreConflictError(
        'Publication requires config, copy, and run stores',
      );
    }

    const { reportKey, runId, configVersion, copyVersion } = triple;
    const { configStore, copyStore, runStore } = this.#publicationStores;
    const [config, copy, run] = await Promise.all([
      configStore.getVersion(reportKey, configVersion),
      copyStore.getVersion(reportKey, copyVersion),
      runStore.get(runId),
    ]);

    assertPublishable({
      triple: { reportKey, runId, configVersion, copyVersion },
      receipt,
      config,
      copy,
      run,
      artifact: this.artifacts.get(`${reportKey}/${runId}`) ?? null,
    });

    this.#published.set(reportKey, runId);
  }

  listReportKeys(): Promise<string[]> {
    return Promise.resolve([...this.reports.keys()].sort());
  }
}

export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();

  start(record: RunRecord): Promise<void> {
    if (!this.runs.has(record.runId)) {
      this.runs.set(record.runId, record);
    }

    return Promise.resolve();
  }

  claim(runId: string, claim: RunClaim): Promise<RunClaimResult> {
    const result = evaluateRunClaim(this.runs.get(runId) ?? null, claim);

    if (result.status === 'claimed') {
      this.runs.set(runId, result.record);
    }

    return Promise.resolve(result);
  }

  reconcile(
    runId: string,
    outcome: RunReconciliation,
    claim: RunClaim,
  ): Promise<boolean> {
    const record = this.runs.get(runId);

    if (
      !record ||
      isTerminalRun(record) ||
      record.batchJobId !== claim.batchJobId ||
      record.batchAttempt !== claim.attempt
    ) {
      return Promise.resolve(false);
    }

    this.runs.set(runId, { ...record, ...outcome });

    return Promise.resolve(true);
  }

  finish(
    runId: string,
    outcome: Pick<RunRecord, 'status' | 'finishedAt' | 'partialFailures'> &
      Partial<Pick<RunRecord, 'logLocation'>>,
  ): Promise<void> {
    return settle(() => {
      const existing = this.runs.get(runId);

      if (!existing) {
        throw new Error(`Unknown run: ${runId}.`);
      }

      if (!isTerminalRun(existing)) {
        this.runs.set(runId, { ...existing, ...outcome });
      }
    });
  }

  get(runId: string): Promise<RunRecord | null> {
    return Promise.resolve(this.runs.get(runId) ?? null);
  }
}

export type MemoryStores = {
  configStore: ConfigStore;
  copyStore: CopyStore;
  probeStore: MemoryProbeStore;
  analysisStore: MemoryAnalysisStore;
  reportStore: MemoryReportStore;
  runStore: MemoryRunStore;
} & Stores;

export const memoryStores = (
  seed: {
    probes?: Iterable<UnitRecord>;
    analyses?: Iterable<AnalysisEntry>;
    reports?: ConstructorParameters<typeof MemoryReportStore>[0];
  } = {},
): MemoryStores => {
  const versions = memoryVersionStores();
  const runStore = new MemoryRunStore();
  const stores = {
    ...versions,
    probeStore: new MemoryProbeStore(seed.probes),
    analysisStore: new MemoryAnalysisStore(seed.analyses),
    reportStore: new MemoryReportStore(seed.reports, { ...versions, runStore }),
    runStore,
  };

  return stores;
};
