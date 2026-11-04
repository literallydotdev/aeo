import { z } from 'zod';

/** Prose is plain text. URLs belong in evidence, never model-authored copy. */
export const reportProseSchema = z
  .string()
  .max(20_000)
  .refine(
    (value) =>
      !/(?:https?:|ftp:)\/\/|(?:javascript|data):|www\.|\[[^\]]*\]\([^)]*\)|<\/?[a-z][^>]*>/i.test(
        value,
      ),
    'Report prose cannot contain URLs, markdown links, or HTML',
  )
  // A refinement cannot be expressed in JSON Schema, so a writer is only told
  // this rule if the description carries it.
  .describe(
    'Plain prose. No URLs, no markdown links, and no HTML; cite evidence by fact ID instead.',
  );

export const aeoSectionCopySchema = z
  .object({
    anchor: z.string().regex(/^[a-zA-Z0-9-]+$/),
    title: reportProseSchema,
    subtitle: reportProseSchema,
    perceptionCopy: reportProseSchema.optional(),
    retrievalCopy: reportProseSchema.optional(),
  })
  .strict();

export const aeoReportCopySchema = z
  .object({
    reportKey: z.string().min(1),
    heroEyebrow: reportProseSchema.optional(),
    brandLogo: z
      .object({
        src: z
          .string()
          .regex(
            /^(?:\/assets\/[^?#]+|\/aeo-insights-assets\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}\.png)$/,
          )
          .refine((src) => !src.split('/').includes('..')),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),
    title: reportProseSchema,
    metaDescription: reportProseSchema,
    subtitle: reportProseSchema,
    preparedBy: reportProseSchema,
    eyebrow: reportProseSchema,
    heading: reportProseSchema,
    intro: reportProseSchema,
    pendingBadge: reportProseSchema,
    pendingBody: reportProseSchema,
    sections: z.record(z.string(), aeoSectionCopySchema),
    actionPlan: z
      .object({
        heading: reportProseSchema,
        intro: reportProseSchema,
        items: z.array(
          z
            .object({ title: reportProseSchema, body: reportProseSchema })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    methodologyNote: reportProseSchema,
    footerNote: reportProseSchema,
  })
  .strict();

export type AeoReportCopy = z.infer<typeof aeoReportCopySchema>;
export type AeoSectionCopy = z.infer<typeof aeoSectionCopySchema>;
