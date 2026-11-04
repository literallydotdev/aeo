import { z } from 'zod';
import { aeoReportCopySchema } from './core/copy-schema';
import { progressMeasurementSchema } from './core/progress-schema';
import {
  aeoSnapshotSchema,
  brandSchema,
  sourceCategorySchema,
} from './core/schema';

/** Shared ceiling for released JSON responses, below API Gateway/Lambda limits. */
export const releasedJsonLimit = 4 * 1024 * 1024;

export const reportKeySchema = z.string().regex(/^[a-zA-Z0-9_-]{1,180}$/);
export const releaseIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const reportConfigSchema = z
  .object({
    reportKey: reportKeySchema,
    slug: reportKeySchema,
    brand: brandSchema,
    competitors: z.array(brandSchema).max(100),
    sections: z
      .array(
        z
          .object({
            key: reportKeySchema,
            promptCount: z.number().int().nonnegative().max(10000),
            competitors: z.array(brandSchema).max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    sourceOverrides: z.record(z.string(), sourceCategorySchema).optional(),
  })
  .strict();

export type ReportConfig = z.infer<typeof reportConfigSchema>;

// The renderer also accepts existing website configs without exposing their
// operational fields in the authenticated transport DTO.
export type RenderConfig = Omit<ReportConfig, 'sections'> & {
  sections: Array<{
    key: string;
    competitors?: ReportConfig['competitors'];
    promptCount?: number;
    prompts?: readonly unknown[];
  }>;
};

export const reportCopySchema = aeoReportCopySchema.omit({ actionPlan: true });
export type ReportCopy = z.infer<typeof reportCopySchema>;

export const reportDisplaySchema = z
  .object({
    config: reportConfigSchema,
    copy: reportCopySchema,
    snapshot: aeoSnapshotSchema,
    domainLabels: z.record(z.string(), sourceCategorySchema),
    copyPresentation: z.enum(['generated', 'authored']),
  })
  .strict();

export const reportReleaseSchema = z
  .object({
    id: releaseIdSchema,
    runId: reportKeySchema,
    configVersion: z.number().int().positive(),
    copyVersion: z.number().int().positive(),
    policyRevision: z.number().int().positive(),
    publishedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const reportHistorySchema = z
  .object({
    items: z.array(progressMeasurementSchema).max(50),
    nextCursor: z.string().max(2048).nullable(),
    truncated: z.boolean(),
  })
  .strict();

export const clientReportBundleSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        schemaVersion: z.literal(1),
        reportKey: reportKeySchema,
        state: z.literal('unreleased'),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        reportKey: reportKeySchema,
        state: z.literal('released'),
        release: reportReleaseSchema,
        report: reportDisplaySchema,
        history: reportHistorySchema,
      })
      .strict(),
  ])
  .superRefine((bundle, context) => {
    if (bundle.state !== 'released') {
      return;
    }

    const { config, copy, snapshot } = bundle.report;

    if (
      [config.reportKey, copy.reportKey, snapshot.reportKey].some(
        (key) => key !== bundle.reportKey,
      ) ||
      (snapshot.meta.runId !== undefined &&
        snapshot.meta.runId !== bundle.release.runId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Report artifacts do not match the release',
      });
    }

    if (config.sections.some((section) => !copy.sections[section.key])) {
      context.addIssue({
        code: 'custom',
        message: 'Report section copy is incomplete',
      });
    }

    for (const section of snapshot.sections) {
      if (!config.sections.some((item) => item.key === section.key)) {
        context.addIssue({
          code: 'custom',
          message: 'Unexpected snapshot section',
        });
      }

      for (const row of section.visibility.matrix) {
        if (
          row.evidenceFile &&
          row.evidenceFile !== `evidence/${section.key}-${row.promptIdx}.json`
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Invalid evidence reference',
          });
        }
      }
    }
  });

export type ClientReportBundle = z.infer<typeof clientReportBundleSchema>;
export type ReleasedClientReport = Extract<
  ClientReportBundle,
  { state: 'released' }
>;

export { aeoEvidenceChunkSchema } from './core/schema';
export type { AeoEvidenceChunk, AeoSnapshot } from './core/schema';
export { progressMeasurementSchema } from './core/progress-schema';
export type { ProgressMeasurement } from './core/progress-schema';
