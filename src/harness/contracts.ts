import { z } from 'zod';

// ============================================================================
// Execution contracts. An execution is the durable record of one admitted
// report job: which pipeline and report it serves, the manifests pinned as
// its inputs became known, the state it is in and who owns it. The Codex
// workflow (specs/aeo-codex-workflow-spec.md §9) does its judgment work over
// local files and commits once; the execution only has to say whether that
// commit happened, and why not when it did not. Unknown fields are rejected
// at the boundary; hashes prove identity, not truth.
// ============================================================================

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const idSchema = z.string().regex(/^[A-Za-z0-9_.:@|-]{1,200}$/);
const shortText = (max: number) => {
  return z.string().min(1).max(max);
};

/** The three manifests an execution pins, in the order they become known. */
export const artifactKindSchema = z.enum([
  'admission_manifest',
  'approved_run_manifest',
  'measurement_start',
  'workflow_checkpoint',
  'workflow_checkpoint_chunk',
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const artifactRefSchema = z
  .object({
    kind: artifactKindSchema,
    id: idSchema,
    digest: digestSchema,
    schemaVersion: z.number().int().positive(),
  })
  .strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const dispatchModeSchema = z.enum(['measure', 'resume']);
export type DispatchMode = z.infer<typeof dispatchModeSchema>;

/** Why an execution stopped before its commit. `resumable` on the state
 * says whether the same execution continues once the condition clears. */
export const blockedReasonSchema = z.enum([
  'credentials',
  'credits',
  'provider_unavailable',
  'budget',
  'deadline',
  'integrity',
  'configuration',
  'code_defect',
  'capture_window',
  'unsupported_version',
]);
export type BlockedReason = z.infer<typeof blockedReasonSchema>;

export const executionStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created') }).strict(),
  z
    .object({
      kind: z.literal('running'),
      stage: shortText(80),
      unit: shortText(200).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('blocked'),
      reason: blockedReasonSchema,
      dependency: shortText(80).nullable(),
      unit: shortText(200).nullable(),
      // Redacted, operator-facing. Never prompts, answers or credentials.
      detail: z.string().max(500),
      resumable: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('cancelled') }).strict(),
  // The run's report and copy were committed in one transaction; the
  // scorecard and the copy receipt are the record of how it went.
  z
    .object({
      kind: z.literal('completed'),
      runId: idSchema,
      copyVersion: z.number().int().positive().nullable(),
      verdict: shortText(40),
    })
    .strict(),
]);
export type ExecutionState = z.infer<typeof executionStateSchema>;

export const terminalStateKinds = ['cancelled', 'completed'] as const;

export const isTerminalState = (state: ExecutionState): boolean => {
  return terminalStateKinds.some((kind) => kind === state.kind);
};

/** The run a finished measurement names; nothing before completion does. */
export const runIdOfState = (state: ExecutionState): string | null => {
  return state.kind === 'completed' ? state.runId : null;
};

// ---------------------------------------------------------------------------
// Manifests. Pinned when their inputs become known: the admission at
// creation, the approved run and the measurement window at the first claim.
// ---------------------------------------------------------------------------

export const admissionManifestSchema = z
  .object({
    version: z.literal(1),
    pipelineId: idSchema,
    reportKey: idSchema,
    tenantScope: shortText(200),
    briefDigest: digestSchema.nullable(),
    intent: z.literal('report'),
    modelProfileId: shortText(80),
    modelProfileDigest: digestSchema,
    harnessVersion: z.number().int().positive(),
    /** The Codex workflow version the admission was priced against
     * (workflowVersion); a build running another one cannot continue it. */
    graphVersion: z.number().int().positive(),
    rubricVersion: z.number().int().positive(),
    policyDigest: digestSchema,
    imageDigest: shortText(200).nullable(),
    gates: z.record(z.string().max(32), shortText(32)),
    audience: z.enum(['client_private', 'unlisted_public']),
    copyOwnership: z.enum(['agent', 'human']),
    rootBudget: z
      .object({
        maxUsd: z.number().finite().positive(),
        maxTokens: z.number().int().positive(),
        deadlineAt: z.iso.datetime(),
      })
      .strict(),
    scopeCeilingUnits: z.number().int().positive(),
    admittedAt: z.iso.datetime(),
  })
  .strict();
export type AdmissionManifest = z.infer<typeof admissionManifestSchema>;

export const approvedRunManifestSchema = z
  .object({
    version: z.literal(1),
    admissionDigest: digestSchema,
    reportKey: idSchema,
    configVersion: z.number().int().positive(),
    configDigest: digestSchema,
    runId: idSchema,
    measurementOrigin: z.enum(['fresh', 'resume']),
    questionSetDigest: digestSchema,
    plannedUnits: z.number().int().nonnegative(),
    surfaces: z.array(shortText(64)).max(32),
    collectionWindowHours: z.number().int().positive(),
    remainingBudgetCheckedAt: z.iso.datetime(),
    approvedAt: z.iso.datetime(),
  })
  .strict();
export type ApprovedRunManifest = z.infer<typeof approvedRunManifestSchema>;

export const measurementStartSchema = z
  .object({
    version: z.literal(1),
    approvedRunDigest: digestSchema,
    measurementId: idSchema,
    startedAt: z.iso.datetime(),
    windowClosesAt: z.iso.datetime(),
  })
  .strict();
export type MeasurementStart = z.infer<typeof measurementStartSchema>;
