import { z } from 'zod';
import { aeoSnapshotSchema, aeoEvidenceChunkSchema } from '../schema';
import { domainLabelsFileSchema } from '../analysis/domain-labels';
import {
  captureManifestSchema,
  validateCaptureManifest,
  savedAnswersFromManifest,
} from '../capture-manifest';
import { groundingBundleSchema } from '../grounding/schema';
import { validateGroundingBundle } from '../grounding/validation';
import type { ReportArtifacts } from './ports';

const artifactsSchema = z.object({
  snapshot: aeoSnapshotSchema,
  labels: domainLabelsFileSchema,
  chunks: z.array(aeoEvidenceChunkSchema),
  fullScope: z.boolean(),
  configVersion: z.number().int().positive().optional(),
  owner: z
    .object({ batchJobId: z.string(), attempt: z.number().int().positive() })
    .optional(),
  captureManifest: captureManifestSchema.optional(),
  grounding: groundingBundleSchema.optional(),
});

export const validateReportArtifacts = (
  value: unknown,
  reportKey: string,
  runId: string,
): ReportArtifacts => {
  const artifacts = artifactsSchema.parse(value);

  if (artifacts.snapshot.reportKey !== reportKey) {
    throw new Error(`Artifact belongs to another report than ${reportKey}.`);
  }

  if (
    artifacts.snapshot.meta.runId &&
    artifacts.snapshot.meta.runId !== runId
  ) {
    throw new Error(`Artifact belongs to another run than ${runId}.`);
  }

  if (artifacts.captureManifest) {
    validateCaptureManifest(artifacts.captureManifest, {
      reportKey,
      runId,
      chunks: artifacts.chunks,
    });
  }

  if (artifacts.grounding) {
    if (!artifacts.configVersion) {
      throw new Error(
        `Grounded report ${reportKey}/${runId} requires a pinned config version.`,
      );
    }

    if (!artifacts.captureManifest) {
      throw new Error(
        `Grounded report ${reportKey}/${runId} requires an immutable capture manifest.`,
      );
    }

    validateGroundingBundle(artifacts.grounding, {
      reportKey,
      runId,
      configVersion: artifacts.configVersion,
      answers: savedAnswersFromManifest(artifacts.captureManifest),
    });
  }

  return artifacts;
};
