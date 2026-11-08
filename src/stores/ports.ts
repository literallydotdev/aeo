import type { ZodType } from 'zod';
import type { GroundingBundle } from '../grounding/schema';
import type { CaptureManifest } from '../capture-manifest';
import type {
  AeoEvidenceChunk,
  AeoSnapshot,
  AeoSurface,
  RunRequest,
} from '../schema';
import type { DomainLabelsFile } from '../analysis/domain-labels';
import type { ProbeResult } from '../probes/probes';
import type { AgentProbeResult } from '../probes/agent-clis';
import type { ProbeFailureKind } from '../probes/failure';
import type { PartialFailure } from '../probes/web-tool-guard';
import type { PublicationTriple, PublishReceipt } from './publication';

// ============================================================================
// Storage ports (hardening spec §4.4). The phases of a run touch storage only
// through these three interfaces: an in-memory implementation for tests and
// the golden replay, a file implementation (the interim, today's JSONL
// checkpoints and content/ layout) and a Postgres implementation on the
// dedicated Neon database. Nothing in a phase touches node:fs or process.env.
// ============================================================================

// One planned probe execution: the unit of caching and of resume. promptText
// rides along so an edited prompt never matches its stale cached answer.
export type ProbeUnit = {
  sectionKey: string;
  promptId: string;
  promptText: string;
  surface: AeoSurface;
  runIndex: number;
};

// Selector for targeted invalidation (--redo): omitted fields match
// everything, so { surface } spans sections and { sectionKey, surface }
// pins one pair; {} matches every record (--force).
export type CheckpointMatch = {
  sectionKey?: string;
  surface?: AeoSurface;
};

export type CheckpointProbe = ProbeResult | AgentProbeResult;

type UnitRecordBase = {
  // The run that produced the record. Optional: records from before run
  // identity existed carry none.
  runId?: string;
} & ProbeUnit;

export type CapturedUnitRecord = {
  status: 'captured';
  capturedAt: string;
  probe: CheckpointProbe;
  captureMetadata?: {
    requestedModel: string | null;
    reportedModel: string | null;
    parameters: Record<string, unknown>;
    // The adapter that captured the answer, recorded only when it is not the
    // surface's legacy adapter: absent means the legacy adapter.
    adapter?: string;
  };
} & UnitRecordBase;

// A unit that exhausted its attempts (§4.1). Persisted so a resumed run can
// tell "never attempted" from "failed an hour ago" and the row count is
// auditable; it never satisfies a cache lookup, so the unit re-executes on
// the next resume exactly as a missing entry does.
export type FailedUnitRecord = {
  status: 'failed';
  failedAt: string;
  kind: ProbeFailureKind;
  attempts: number;
  // Never contains the prompt text.
  lastError: string;
} & UnitRecordBase;

export type UnitRecord = CapturedUnitRecord | FailedUnitRecord;

/** Thrown by `put` when a captured record already holds the unit key. */
export class UnitConflictError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Unit already captured: ${key}.`);
    this.name = 'UnitConflictError';
    this.key = key;
  }
}

/**
 * Probe store, scoped to one report. Keys include a hash of the prompt
 * text (§4.2), so an edited prompt is a miss by construction.
 */
export type ProbeStore = {
  /** The record under the unit's key, captured or failed; null when absent. */
  get(unit: ProbeUnit): Promise<UnitRecord | null>;
  /**
   * Writes a record. A captured record never overwrites another captured
   * record for the same key (UnitConflictError — a redelivery is refused,
   * not stored); a failed record overwrites a failed one and a captured
   * record replaces a failed one. A write failure rejects; it is never
   * swallowed.
   */
  put(record: UnitRecord): Promise<void>;
  /** Drops matching records (--redo, --force); returns how many. */
  invalidate(match: CheckpointMatch): Promise<number>;
  /** Every record of the report. */
  list(): Promise<UnitRecord[]>;
};

/** Analysis cache, scoped to one report; an invalid stored value is a miss. */
export type AnalysisStore = {
  get<T>(key: string, schema: ZodType<T>): Promise<T | null>;
  put(key: string, value: unknown, meta?: AnalysisEntryMeta): Promise<void>;
  /** Drops every entry (a fresh measurement); returns how many. */
  clear(): Promise<number>;
  count(): Promise<number>;
};

export type AnalysisEntryMeta = {
  runId?: string;
  // The resolved model id the entry was produced with (§2.11), when known.
  modelId?: string;
  version?: number;
};

export type ReportArtifacts = {
  snapshot: AeoSnapshot;
  grounding?: GroundingBundle;
  captureManifest?: CaptureManifest;
  labels: DomainLabelsFile;
  chunks: AeoEvidenceChunk[];
  // Whether the run covered every section and surface of the config
  // (§4.8): a partial-scope run is stored under its run id but never
  // becomes the report the page renders.
  fullScope: boolean;
  configVersion?: number;
  owner?: { batchJobId: string; attempt: number };
};

/** Published reports across every report key. */
export type ReportStore = {
  /** Exact immutable run inputs/artifacts; never resolves a mutable latest checkpoint. */
  readArtifacts(
    reportKey: string,
    runId: string,
  ): Promise<ReportArtifacts | null>;
  /** Asserts `snapshot.reportKey === reportKey`; null when no report exists. */
  readSnapshot(reportKey: string, runId?: string): Promise<AeoSnapshot | null>;
  readLabels(
    reportKey: string,
    runId?: string,
  ): Promise<DomainLabelsFile | null>;
  /** `file` is the matrix row's `evidenceFile` reference. */
  readEvidenceChunk(
    reportKey: string,
    runIdOrFile: string,
    file?: string,
  ): Promise<AeoEvidenceChunk>;
  writeReport(
    reportKey: string,
    runId: string,
    artifacts: ReportArtifacts,
  ): Promise<void>;
  publish(triple: PublicationTriple, receipt: PublishReceipt): Promise<void>;
  listReportKeys(): Promise<string[]>;
};

// A run's row (§4.8, §4.10): the request, its lifecycle and where its log
// lives. The file backend keeps these under the checkpoint directory; the
// Postgres backend has a `runs` table.
export type RunStatus =
  'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';

export type RunRecord = {
  pipelineId?: string | null;
  configVersion?: number | null;
  batchJobId?: string | null;
  batchAttempt?: number | null;
  dispatchedAt?: string | null;
  failureReason?: string | null;
  runId: string;
  reportKey: string;
  request: RunRequest;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  partialFailures: PartialFailure[];
  logLocation: string | null;
};

export type RunClaim = {
  batchJobId: string;
  attempt: number;
};

export type RunClaimResult =
  | { status: 'missing' }
  | {
      status: 'claimed' | 'terminal' | 'duplicate' | 'fenced';
      record: RunRecord;
    };

export type RunReconciliation = Pick<
  RunRecord,
  'status' | 'finishedAt' | 'partialFailures'
> &
  Partial<Pick<RunRecord, 'failureReason' | 'logLocation'>>;

export type RunStore = {
  claim(runId: string, claim: RunClaim): Promise<RunClaimResult>;
  reconcile(
    runId: string,
    outcome: RunReconciliation,
    claim: RunClaim,
  ): Promise<boolean>;
  start(record: RunRecord): Promise<void>;
  finish(
    runId: string,
    outcome: Pick<RunRecord, 'status' | 'finishedAt' | 'partialFailures'> &
      Partial<Pick<RunRecord, 'logLocation'>>,
  ): Promise<void>;
  get(runId: string): Promise<RunRecord | null>;
};

export type Stores = {
  probeStore: ProbeStore;
  analysisStore: AnalysisStore;
  reportStore: ReportStore;
  runStore: RunStore;
  // Releases the backend's connections; a no-op for the file backend.
  close?: () => Promise<void>;
};
