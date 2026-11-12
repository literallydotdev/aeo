import { z } from 'zod';
import { captureArtifactSchema } from '../harness/report/artifacts';
import { aeoSurfaceSchema } from '../schema';
import { canonicalDigest } from './json';

// ============================================================================
// The portable audit bundle (specs/aeo-open-source-cli-spec.md §7, §8): a
// versioned external contract, distinct from the work directory it is
// projected from. Everything a verifier needs travels inside the bundle;
// nothing here names a database, a Batch job or a machine path.
// ============================================================================

export const toolId = 'literally-aeo';
// The package version, recorded in every journal and bundle; the build and
// version.spec.ts refuse a mismatch with package.json.
export const toolVersion = '0.4.2';
// Version 2: config.json may set chatProbes, and agentProbes.runsPerPrompt
// above 2. A verifier that reads only version 1 then refuses the bundle as
// unsupported instead of dropping its depth and failing it.
// Version 3 (open models spec §8): a run may record `model_catalog`
// operations, and its coverage is assessed over seven operation kinds. A
// verifier that reads only version 2 refuses the bundle as unsupported
// instead of calling the new kind unknown.
export const bundleSchemaVersion = 3;
// A version 1 bundle reads as version 2 at the standard depth.
export const readableBundleSchemaVersions: readonly number[] = [1, 2, 3];
export const traceSchemaVersion = 1;
export const canonicalization = 'literally-aeo-canonical-json-v1';
// Bump when the arithmetic the verifier recomputes changes
// (aggregateJudgments, assembleSectionResult, metricsView): a verifier
// never recomputes an older bundle with a newer method (spec §10), but
// recomputes each readable version with its own arithmetic.
// Version 2 (method release spec §6.2): every published rate carries its
// counts and an approximate 95% interval.
export const calculationVersion = 2;
export const readableCalculationVersions = [1, 2] as const;

export type CalculationVersion = (typeof readableCalculationVersions)[number];

export const isReadableCalculationVersion = (
  version: number,
): version is CalculationVersion => {
  return readableCalculationVersions.some((readable) => readable === version);
};

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[0-9A-Z]{26}$/);
const timestamp = z.iso.datetime();

export const RunOrigin = {
  LOCAL: 'local',
  HOSTED: 'hosted',
  LEGACY_IMPORT: 'legacy_import',
} as const;

export type RunOrigin = (typeof RunOrigin)[keyof typeof RunOrigin];

export const eventTypes = [
  'run_started',
  'plan_frozen',
  'operation_started',
  'operation_finished',
  'output_accepted',
  'output_refused',
  'correction_applied',
  'correction_refused',
  'artifact_reused',
  'budget_amended',
  'run_interrupted',
  'run_resumed',
  'writer_takeover',
  'revision_finalized',
  'run_completed',
  'run_failed',
] as const;

export type EventType = (typeof eventTypes)[number];

/** Every kind of host-visible operation a writer can record (§7.2). A
 * writer declares the kinds it observes in run_started and run_resumed. */
export const operationKinds = [
  'codex_session',
  'host_model_call',
  'probe',
  'canary',
  'research_tool',
  'technical_check',
  // A read of the gateway's model list, to price a model (bundle schema 3).
  'model_catalog',
] as const;

export type OperationKind = (typeof operationKinds)[number];

// The kinds bundle schemas 1 and 2 were written with: a bundle is held to
// the kinds of its own schema version, never to one added after it.
const operationKindsBeforeSchema3: readonly OperationKind[] = [
  'codex_session',
  'host_model_call',
  'probe',
  'canary',
  'research_tool',
  'technical_check',
];

/** The operation kinds a bundle of `schemaVersion` must have observed for
 * its coverage to be `declared`. */
export const operationKindsOf = (
  schemaVersion: number,
): readonly OperationKind[] => {
  return schemaVersion < 3 ? operationKindsBeforeSchema3 : operationKinds;
};

/** One line of events.jsonl. `digest` covers the canonical event without
 * itself; `previousDigest` chains it to the line before (null first). */
export const bundleEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    id: identifier,
    type: z.enum(eventTypes),
    at: timestamp,
    operationId: identifier.nullable(),
    payload: z.record(z.string(), z.unknown()),
    // Immutable objects under objects/sha256/, persisted before the event.
    objects: z.array(digest),
    previousDigest: digest.nullable(),
    digest,
  })
  .strict();

export type BundleEvent = z.infer<typeof bundleEventSchema>;

export const bundleFileSchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    mediaType: z.enum(['application/json', 'application/x-ndjson']),
    sha256: digest,
  })
  .strict();

export type BundleFile = z.infer<typeof bundleFileSchema>;

export const traceCoverageSchema = z.enum(['none', 'partial', 'declared']);

export const bundleManifestSchema = z
  .object({
    bundleSchemaVersion: z.number().int().positive(),
    traceSchemaVersion: z.number().int().positive(),
    canonicalization: z.string(),
    calculationVersion: z.number().int().positive(),
    tool: z
      .object({
        id: z.literal(toolId),
        version: z.string().min(1),
        sourceRevision: z.string().nullable(),
        distributionDigest: digest.nullable(),
        customBuild: z.boolean(),
      })
      .strict(),
    run: z
      .object({
        id: z.string().min(1),
        kind: z.enum(['measurement', 'author']),
        origin: z.enum([
          RunOrigin.LOCAL,
          RunOrigin.HOSTED,
          RunOrigin.LEGACY_IMPORT,
        ]),
        // V1 has no provider attestation: every capture is self-reported
        // by whoever ran it (spec §2).
        captureAuthenticity: z.literal('self_reported'),
        measurementId: identifier,
        // Hosted integration metadata; never the run's identity.
        reportKey: z.string().nullable(),
        execution: z.enum(['completed', 'incomplete']),
        needsImprovement: z.boolean().nullable(),
        // A rejudgment: the finalized revision whose captures this run
        // judged again, carried verbatim under predecessors/.
        derivedFrom: z
          .object({
            kind: z.literal('rejudge'),
            runId: z.string().min(1),
            revisionId: identifier,
            bundleDigest: digest,
          })
          .strict()
          .optional(),
      })
      .strict(),
    revision: z
      .object({
        id: identifier,
        finalizedAt: timestamp,
        predecessor: z
          .object({ id: identifier, bundleDigest: digest })
          .strict()
          .nullable(),
      })
      .strict(),
    digests: z
      .object({
        measurement: digest,
        runPolicy: digest,
        method: digest,
        plan: digest,
      })
      .strict(),
    files: z.array(bundleFileSchema),
    events: z
      .object({
        count: z.number().int().nonnegative(),
        head: digest.nullable(),
      })
      .strict(),
    trace: z
      .object({
        coverage: traceCoverageSchema,
        limitations: z.array(z.string()),
      })
      .strict(),
    // Findings the operator accepted at export (`--accept-findings`): a
    // pattern that looks like a credential in captured or derived content.
    acceptedFindings: z.array(
      z.object({ path: z.string(), kind: z.literal('credential_pattern') }),
    ),
    // A redacted derivative (spec §9): what was withheld and why. Its
    // revision's predecessor is the full revision, named, never carried.
    redactions: z
      .array(
        z
          .object({
            path: z.string().min(1),
            bytes: z.number().int().nonnegative().nullable(),
            sha256: digest.nullable(),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    bundleDigest: digest,
  })
  .strict();

export type BundleManifest = z.infer<typeof bundleManifestSchema>;

/** The manifest's digest covers its canonical value without the digest. */
export const digestManifest = (
  manifest: Omit<BundleManifest, 'bundleDigest'>,
): string => {
  return canonicalDigest(manifest);
};

/** measurementDigest identifies what a run measures: the configuration,
 * surfaces and section scope. Run policy and method are digested apart, so
 * changing a budget never changes measurement identity (spec §4.1). */
export const measurementDigest = (inputs: {
  config: unknown;
  surfaces: readonly string[];
  sections: readonly string[] | null;
}): string => {
  return canonicalDigest({
    config: inputs.config,
    surfaces: inputs.surfaces,
    sections: inputs.sections,
  });
};

/** inputs/plan.json: the frozen measurement plan and run policy. */
export const planDocumentSchema = z
  .object({
    version: z.literal(1),
    surfaces: z.array(aeoSurfaceSchema),
    sections: z.array(z.string().min(1)).nullable(),
    plan: z.object({
      configDigest: digest,
      units: z.array(
        z.object({
          sectionKey: z.string(),
          promptId: z.string(),
          promptText: z.string(),
          surface: aeoSurfaceSchema,
          runIndex: z.number().int(),
        }),
      ),
      digest,
    }),
    capture: captureArtifactSchema,
    runPolicy: z.record(z.string(), z.unknown()),
  })
  .strict();

export type PlanDocument = z.infer<typeof planDocumentSchema>;

/** The parts of a bundle the exporter and verifier both name. */
export const bundlePaths = {
  manifest: 'manifest.json',
  config: 'inputs/config.json',
  plan: 'inputs/plan.json',
  method: 'inputs/method.json',
  author: 'inputs/author/declaration.json',
  authorRecord: 'inputs/author/record.json',
  authorDiff: 'inputs/author/diff.json',
  auditFile: 'inputs/audit.json',
  runtime: 'runtime.json',
  events: 'events.jsonl',
  captures: 'captures/units.json',
  captureManifest: 'captures/manifest.json',
  analyze: 'analysis/analyze.json',
  qualify: 'analysis/qualify.json',
  review: 'analysis/review.json',
  corrections: 'analysis/corrections.json',
  reviewProgress: 'analysis/review-progress.json',
  grounding: 'grounding/bundle.json',
  aggregate: 'report/aggregate.json',
  metrics: 'report/metrics.json',
  snapshot: 'report/snapshot.json',
  labels: 'report/labels.json',
  partialFailures: 'report/partial-failures.json',
  copy: 'report/copy.json',
  scorecard: 'report/scorecard.json',
  usage: 'usage.json',
} as const;

export const objectPathPrefix = 'objects/sha256/';

/** Where a derived bundle carries the revision it derives from. Revision
 * ids are case-insensitive ULIDs, lowercased into the bundle path set. */
export const predecessorPrefix = (revisionId: string): string => {
  return `predecessors/${revisionId.toLowerCase()}/`;
};
