import type {
  AdmissionManifest,
  ApprovedRunManifest,
  ArtifactRef,
  DispatchMode,
  ExecutionState,
  MeasurementStart,
} from './contracts';
import type { HarnessPolicy } from './policy';

// ============================================================================
// Execution store port. Postgres is authoritative. Every mutating call
// carries a fence: the owner generation issued by `claim`. A stale
// generation can never move the state or pin a manifest, and the report
// commit (codex-workflow/commit.ts) checks the same owner on the run row,
// so a job whose lease was taken over cannot publish.
// ============================================================================

export type HarnessOwner = {
  batchJobId: string;
  attempt: number;
};

export type HarnessFence = {
  executionId: string;
  generation: number;
  owner: HarnessOwner;
};

export type HarnessExecution = {
  executionId: string;
  pipelineId: string | null;
  reportKey: string;
  operationKey: string;
  mode: DispatchMode;
  manifests: {
    admission: ArtifactRef;
    approvedRun: ArtifactRef | null;
    measurementStart: ArtifactRef | null;
    /** The current checkpoint index; null until the first save advances it. */
    checkpoint: ArtifactRef | null;
  };
  policy: HarnessPolicy;
  state: ExecutionState;
  generation: number;
  owner: HarnessOwner | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  cancelRequestedAt: string | null;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaimResult =
  | { status: 'missing' }
  | { status: 'terminal'; execution: HarnessExecution }
  | {
      status: 'lease_held';
      execution: HarnessExecution;
      leaseExpiresAt: string;
    }
  /** An older Batch attempt can never take over from a newer one. */
  | { status: 'superseded'; execution: HarnessExecution }
  | { status: 'claimed'; execution: HarnessExecution; fence: HarnessFence };

export class HarnessFencedError extends Error {
  constructor(message = 'Harness execution owner changed') {
    super(message);
    this.name = 'HarnessFencedError';
  }
}

export class HarnessCancelledError extends Error {
  constructor() {
    super('Harness execution cancellation was requested');
    this.name = 'HarnessCancelledError';
  }
}

/**
 * HarnessShutdownError means the host process is going away (SIGTERM, a Batch
 * replacement, a lost lease). Not an operator decision: the execution stays
 * `running` for the next attempt to resume from the banked captures.
 */
export class HarnessShutdownError extends Error {
  constructor(message = 'Harness host is shutting down') {
    super(message);
    this.name = 'HarnessShutdownError';
  }
}

export class HarnessIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessIntegrityError';
  }
}

export class HarnessConflictError extends Error {
  readonly conflict: 'terminal' | 'state';

  constructor(conflict: 'terminal' | 'state', message: string) {
    super(message);
    this.conflict = conflict;
    this.name = 'HarnessConflictError';
  }
}

export const artifactByteLimit = 1024 * 1024;

export type HarnessStore = {
  create(input: {
    executionId: string;
    pipelineId: string | null;
    reportKey: string;
    operationKey: string;
    mode: DispatchMode;
    policy: HarnessPolicy;
    deadlineAt: string;
    admission: AdmissionManifest;
  }): Promise<HarnessExecution>;
  get(executionId: string): Promise<HarnessExecution | null>;
  findByOperationKey(operationKey: string): Promise<HarnessExecution | null>;

  claim(executionId: string, owner: HarnessOwner): Promise<ClaimResult>;
  heartbeat(fence: HarnessFence): Promise<{ cancelRequested: boolean }>;
  requestCancel(executionId: string): Promise<void>;
  /** Moves the state; a block or a completion also releases the lease so
   * the next attempt, or the operator, need not wait it out. */
  transition(fence: HarnessFence, state: ExecutionState): Promise<void>;
  /** Admission's re-entry for a copy pass: a completed execution goes back
   * to running at the copy stage, ownerless, so the next report job claims
   * it and rewrites the copy over the committed run. Already reopened is a
   * no-op; anything else refuses. */
  reopenForCopy(executionId: string): Promise<void>;

  pinApprovedRun(
    fence: HarnessFence,
    manifest: ApprovedRunManifest,
  ): Promise<ArtifactRef>;
  pinMeasurementStart(
    fence: HarnessFence,
    manifest: MeasurementStart,
  ): Promise<ArtifactRef>;
  readArtifact(executionId: string, ref: ArtifactRef): Promise<unknown>;
  readCheckpoint(executionId: string): Promise<{
    scope: string;
    files: Record<string, string>;
  } | null>;
  /** Saves immutable file chunks first, under no lock, then advances the
   * checkpoint index under the fence in one short transaction, so a large
   * save never holds the execution row past a heartbeat or a claim. A null
   * entry removes an obsolete file; concurrent batches merge their patches. */
  saveCheckpoint(
    fence: HarnessFence,
    scope: string,
    files: Readonly<Record<string, string | null>>,
  ): Promise<void>;
};

export const artifactId = (
  kind: ArtifactRef['kind'],
  digest: string,
): string => {
  return `${kind}:${digest.slice(0, 40)}`;
};
