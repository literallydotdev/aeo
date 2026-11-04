import { z } from 'zod';
import {
  aeoSurfaceSchema,
  aeoTechnicalChecksSchema,
  partialFailureSchema,
} from '../../schema';
import { probeFailureKinds } from '../../probes/failure';
import { agentSurfaces } from '../../surfaces';

// ============================================================================
// What the paid half of a run hands the Codex workflow: the capture
// artifact summarising every banked probe unit per section, and the client
// site's technical checks. Both are strict, versioned documents the work
// directory materialises from (specs/aeo-codex-workflow-spec.md §3).
// ============================================================================

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const agentSurfaceSchema = z.enum(agentSurfaces);

export const agentCliVersionsSchema = z
  .object({
    claudeCode: z.string().nullable(),
    codex: z.string().nullable(),
    cursor: z.string().nullable(),
  })
  .strict();

export const capturedUnitSchema = z
  .object({
    unitKey: z.string().min(1),
    promptId: z.string().min(1),
    surface: aeoSurfaceSchema,
    runIndex: z.number().int().positive(),
    // Digest of the raw probe text; the work directory verifies it before
    // writing the answer file from the probe store.
    rawDigest: digest,
    capturedAt: z.iso.datetime(),
  })
  .strict();

export const sectionCaptureArtifactSchema = z
  .object({
    units: z.array(capturedUnitSchema),
    coverage: z.array(
      z
        .object({
          surface: aeoSurfaceSchema,
          planned: z.number().int().nonnegative(),
          captured: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    lostPromptIds: z.array(z.string()),
    unitFailures: z.array(
      z
        .object({
          promptId: z.string(),
          surface: aeoSurfaceSchema,
          runIndex: z.number().int(),
          kind: z.enum(probeFailureKinds),
          attempts: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    rejectedWebToolSurfaces: z.array(agentSurfaceSchema),
    freshChatRetrieval: z.array(
      z
        .object({
          surface: aeoSurfaceSchema,
          retrievalCalls: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    ),
    // The pipeline records retrieval per probe surface; only agent probes
    // appear here, but the shape mirrors the runner's so the same web-tool
    // guard reads both.
    freshAgentRetrieval: z.array(
      z
        .object({
          surface: aeoSurfaceSchema,
          usedWebSearch: z.boolean().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type SectionCaptureArtifact = z.infer<
  typeof sectionCaptureArtifactSchema
>;

export const captureArtifactSchema = z
  .object({
    version: z.literal(1),
    reportKey: z.string().min(1),
    runId: z.string().min(1),
    planDigest: digest,
    plannedUnits: z.number().int().nonnegative(),
    surfaces: z.array(aeoSurfaceSchema),
    sections: z.record(z.string(), sectionCaptureArtifactSchema),
    // Sections whose capture produced nothing; never an all-zero baseline.
    failedSections: z.array(
      z.object({ key: z.string(), error: z.string().max(500) }).strict(),
    ),
    resumed: z
      .object({
        count: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        oldestCapturedAt: z.iso.datetime().nullable(),
      })
      .strict(),
    /** The agent CLI versions the capture ran with: provenance the snapshot
     * reports, bound here so the snapshot cannot re-detect it later. */
    agentCliVersions: agentCliVersionsSchema,
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
  })
  .strict();
export type CaptureArtifact = z.infer<typeof captureArtifactSchema>;

/** The client site's technical checks, fetched once per run. */
export const technicalChecksArtifactSchema = z
  .object({
    version: z.literal(1),
    checks: aeoTechnicalChecksSchema.nullable(),
    failures: z.array(partialFailureSchema),
  })
  .strict();
export type TechnicalChecksArtifact = z.infer<
  typeof technicalChecksArtifactSchema
>;
