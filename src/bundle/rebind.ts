import { z } from 'zod';
import {
  aeoAuditConfigSchema,
  aeoEvidenceChunkSchema,
  aeoSnapshotSchema,
  partialFailureSchema,
  type AeoAuditConfig,
  type AeoEvidenceChunk,
  type AeoSnapshot,
} from '../schema';
import {
  domainLabelsFileSchema,
  type DomainLabelsFile,
} from '../analysis/domain-labels';
import {
  validateCaptureManifest,
  type CaptureManifest,
} from '../capture-manifest';
import type { GroundingBundle } from '../grounding/schema';
import {
  assessmentDigest,
  groundingDigest,
  sourceBundleDigest,
  validateGroundingBundle,
} from '../grounding/validation';
import { contentHash } from '../stores/content-hash';
import { validateReportArtifacts } from '../stores/artifacts';
import { bundlePaths } from './contracts';
import { canonicalDigest, parseBundleJson } from './json';

// ============================================================================
// Rebinding a verified bundle to a hosted report (website
// specs/aeo-bundle-import-spec.md §7.1). A local run seals its own report
// key, config version and run ID into the capture manifest and the
// grounding, under digests; a hosted run is checked against the hosted
// identity. This moves the run to that identity and changes nothing else:
// the measured answers, judgments, metrics and brand stay as the bundle
// recorded them, and every digest over a changed field is recomputed by
// the function that defines it, so the hosted checks hold and a reader can
// trace the hosted run back to the bundle plus this mechanical change.
// ============================================================================

type PartialFailure = z.infer<typeof partialFailureSchema>;

export type RebindTarget = {
  reportKey: string;
  slug: string;
  configVersion: number;
  runId: string;
};

export type ReboundRun = {
  /** The frozen config under the hosted report key and slug. */
  config: AeoAuditConfig;
  snapshot: AeoSnapshot;
  labels: DomainLabelsFile;
  captureManifest: CaptureManifest;
  grounding: GroundingBundle | null;
  chunks: AeoEvidenceChunk[];
  partialFailures: PartialFailure[];
  /** The canonical digest of everything above. */
  digest: string;
};

/** Thrown when the bundle cannot be rebound; the same bytes always throw. */
export class RebindError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RebindError';
  }
}

const readDocument = (
  files: ReadonlyMap<string, Buffer>,
  file: string,
): unknown => {
  const bytes = files.get(file);

  if (bytes === undefined) {
    throw new RebindError(`The bundle has no ${file}.`);
  }

  return parseBundleJson(bytes.toString('utf8'));
};

/**
 * rebindConfig returns the bundle's frozen config under the hosted report's
 * key and slug (as the clone route rebinds a config): what an imported run
 * is measured under, and what the hosted platform stores as its version.
 */
export const rebindConfig = (
  files: ReadonlyMap<string, Buffer>,
  { reportKey, slug }: Pick<RebindTarget, 'reportKey' | 'slug'>,
): AeoAuditConfig => {
  const frozen = aeoAuditConfigSchema.parse(
    readDocument(files, bundlePaths.config),
  );

  return { ...frozen, reportKey, slug };
};

const rebindCaptureManifest = (
  source: CaptureManifest,
  runId: string,
  reportKey: string,
): CaptureManifest => {
  // A capture this run took names the run as its origin; one it reused
  // from an earlier local run keeps naming that run, so the hosted run
  // reports the same mix of fresh and reused answers the bundle did.
  const captures = source.captures.map(({ digest: _digest, ...capture }) => {
    const rebound = {
      ...capture,
      originRunId:
        capture.originRunId === source.runId ? runId : capture.originRunId,
    };

    return { ...rebound, digest: contentHash(rebound) };
  });
  const { digest: _digest, ...rest } = source;
  const manifest = { ...rest, reportKey, runId, captures };

  return validateCaptureManifest(
    { ...manifest, digest: contentHash(manifest) },
    { reportKey, runId },
  );
};

const rebindGrounding = (
  source: GroundingBundle,
  { reportKey, configVersion, runId }: RebindTarget,
  previousRunId: string,
): GroundingBundle => {
  const candidates = source.candidates.map((candidate) => ({
    ...candidate,
    occurrences: candidate.occurrences.map((occurrence) => ({
      ...occurrence,
      runId: occurrence.runId === previousRunId ? runId : occurrence.runId,
    })),
  }));
  const identity = {
    ...source,
    configIdentity: { reportKey, configVersion },
    ...(source.runId === undefined ? {} : { runId }),
    candidates,
  };
  const sourceDigest = sourceBundleDigest(identity);
  const assessments = source.assessments.map((assessment) => {
    const rebound = { ...assessment, sourceBundleDigest: sourceDigest };

    return { ...rebound, digest: assessmentDigest(rebound) };
  });
  const withSources = {
    ...identity,
    assessments,
    sourceBundleDigest: sourceDigest,
  };

  return { ...withSources, digest: groundingDigest(withSources) };
};

const partialFailuresSchema = z.array(partialFailureSchema);

// Only the evidence chunks are read from the aggregate: they are what the
// hosted run stores, and the verifier has already recomputed the rest.
const aggregateChunksSchema = z.object({
  sections: z.record(
    z.string(),
    z.looseObject({ evidenceChunks: z.array(aeoEvidenceChunkSchema) }),
  ),
});

/**
 * rebindImportedRun returns the frozen config and the report artifacts a
 * hosted commit writes for a verified bundle, bound to the hosted report,
 * config version and run. It refuses with a RebindError what it cannot
 * rebind, and checks the result with the same validation every hosted
 * artifact write applies.
 */
export const rebindImportedRun = (
  files: ReadonlyMap<string, Buffer>,
  target: RebindTarget,
): ReboundRun => {
  try {
    const { reportKey, configVersion, runId } = target;
    const config = rebindConfig(files, target);
    const localSnapshot = aeoSnapshotSchema.parse(
      readDocument(files, bundlePaths.snapshot),
    );
    const localManifest = validateCaptureManifest(
      readDocument(files, bundlePaths.captureManifest),
    );
    const groundingBytes = files.get(bundlePaths.grounding);
    const localGrounding =
      groundingBytes === undefined
        ? null
        : validateGroundingBundle(
            parseBundleJson(groundingBytes.toString('utf8')),
          );
    const aggregate = aggregateChunksSchema.parse(
      readDocument(files, bundlePaths.aggregate),
    );
    const chunks = Object.values(aggregate.sections).flatMap(
      (section) => section.evidenceChunks,
    );
    const labels = domainLabelsFileSchema.parse(
      readDocument(files, bundlePaths.labels),
    );
    const partialFailures = files.has(bundlePaths.partialFailures)
      ? partialFailuresSchema.parse(
          readDocument(files, bundlePaths.partialFailures),
        )
      : [];

    const snapshot: AeoSnapshot = {
      ...localSnapshot,
      reportKey,
      meta: {
        ...localSnapshot.meta,
        ...(localSnapshot.meta.runId === undefined ? {} : { runId }),
      },
    };
    const captureManifest = rebindCaptureManifest(
      localManifest,
      runId,
      reportKey,
    );
    const grounding = localGrounding
      ? rebindGrounding(localGrounding, target, localManifest.runId)
      : null;

    // The hosted write's own check: the manifest and the grounding against
    // the hosted report, run and config version, the grounding's candidates
    // against the manifest's answers.
    validateReportArtifacts(
      {
        snapshot,
        labels,
        chunks,
        fullScope: true,
        configVersion,
        captureManifest,
        ...(grounding ? { grounding } : {}),
      },
      reportKey,
      runId,
    );

    const rebound = {
      config,
      snapshot,
      labels,
      captureManifest,
      grounding,
      chunks,
      partialFailures,
    };

    return { ...rebound, digest: canonicalDigest(rebound) };
  } catch (error) {
    // A RebindError is already a refusal; a TypeError or ReferenceError is
    // a bug here, not a verdict on the bundle, and must not end its import.
    if (
      error instanceof RebindError ||
      error instanceof TypeError ||
      error instanceof ReferenceError
    ) {
      throw error;
    }

    throw new RebindError(
      `The bundle cannot be rebound to ${target.reportKey}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};
