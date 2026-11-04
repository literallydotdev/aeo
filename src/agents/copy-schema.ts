import { z } from 'zod';
import type { AeoAuditConfig } from '../schema';
import { reportSectionTitle } from '../lib/report-presentation';
import {
  reportProseSchema,
  type AeoReportCopy,
} from '../report/core/copy-schema';

export * from '../report/core/copy-schema';

const catalogFactIdSchema = z
  .string()
  .min(1)
  .describe(
    'Exact FACTS.json factId, including its prefix, for example assessment:claim_abc. Use factId for fact blocks and recommendation basisFactIds.',
  );

const premisesSchema = z
  .array(
    z
      .object({
        proposition: reportProseSchema.min(1).max(1500),
        basisFactIds: z.array(catalogFactIdSchema).min(1).max(20),
      })
      .strict(),
  )
  .min(1)
  .max(20);

/** Natural report prose still declares the evidence for every factual premise. */
export const narrativeBlockSchema = z
  .object({
    kind: z.literal('narrative'),
    text: reportProseSchema
      .min(1)
      .max(1200)
      .refine(
        (text) => text.trim().split(/\s+/).length <= 130,
        'The introduction must fit in 130 words',
      )
      // Word limits are refinements, invisible in JSON Schema; a writer only
      // learns them from the description it is given.
      .describe(
        'Plain prose, at most 130 words. No URLs, markdown links, or HTML.',
      ),
    basisFactIds: z.array(catalogFactIdSchema).min(1).max(20),
    premises: premisesSchema,
  })
  .strict();

/** The final opening uses the same evidence contract as the insight narrative. */
export const reportHeroDraftSchema = z
  .object({
    title: narrativeBlockSchema.extend({
      text: reportProseSchema
        .min(1)
        .max(140)
        .refine(
          (text) => text.trim().split(/\s+/).length <= 24,
          'The headline must fit in 24 words',
        )
        .describe(
          'The headline, at most 24 words. No URLs, markdown links, or HTML.',
        ),
    }),
    subtitle: narrativeBlockSchema.extend({
      text: reportProseSchema
        .min(1)
        .max(700)
        .refine(
          (text) => text.trim().split(/\s+/).length <= 90,
          'The supporting description must fit in 90 words',
        )
        .describe(
          'The supporting description, at most 90 words. No URLs, markdown links, or HTML.',
        ),
    }),
  })
  .strict();

export const copyBlockSchema = z.discriminatedUnion('kind', [
  narrativeBlockSchema,
  z.object({ kind: z.literal('fact'), factId: catalogFactIdSchema }).strict(),
  z
    .object({
      kind: z.literal('assessment'),
      assessmentId: z
        .string()
        .min(1)
        .describe(
          'Exact assessmentId from an assessment entry in FACTS.json, for example claim_abc. This is the bare claim ID; never use the prefixed factId assessment:claim_abc here.',
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('recommendation'),
      text: reportProseSchema.min(1).max(1500),
      intendedAction: reportProseSchema.min(1).max(1000),
      basisFactIds: z.array(catalogFactIdSchema).min(1).max(20),
      premises: premisesSchema,
    })
    .strict(),
]);

const blocksSchema = z.array(copyBlockSchema).min(1).max(30);

export const aeoAgentCopyDraftSchema = z
  .object({
    intro: blocksSchema,
    sections: z.record(
      z.string(),
      z
        .object({
          subtitle: z.array(copyBlockSchema).max(30),
          perceptionCopy: blocksSchema.optional(),
          retrievalCopy: blocksSchema.optional(),
        })
        .strict(),
    ),
    actionPlan: z
      .array(z.object({ body: blocksSchema }).strict())
      .max(12)
      .optional(),
    hero: reportHeroDraftSchema.optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type AeoAgentCopyDraft = z.infer<typeof aeoAgentCopyDraftSchema>;
export type CopyBlock = z.infer<typeof copyBlockSchema>;

/** The pinned v2 writer produces only the introduction. Tables own detailed
 * measurements; historical drafts remain readable through the schema above. */
export const aeoNarrativeCopyDraftSchema = z
  .object({
    intro: z.array(narrativeBlockSchema).length(1),
    sections: z.record(
      z.string(),
      z
        .object({
          subtitle: z.array(z.object({}).strict()).max(0),
        })
        .strict(),
    ),
    confidence: z.number().min(0).max(1),
  })
  .strict();

/** Written after the completed audit: insight first, then its opening frame. */
export const aeoFinalCopyDraftSchema = aeoNarrativeCopyDraftSchema.extend({
  hero: reportHeroDraftSchema,
});

/**
 * finalCopyDraftSchemaForSections builds the final draft contract with the
 * configured sections named as required keys, so a draft that omits a section
 * is refused at the schema instead of by a later check. Measured 2026-09-12: a
 * writer's last draft returned `sections: {}` against the open record. The
 * contract itself is unchanged; only the keys the config already requires are
 * constrained.
 */
export const finalCopyDraftSchemaForSections = (
  sectionKeys: readonly string[],
) => {
  if (!sectionKeys.length) {
    return aeoFinalCopyDraftSchema;
  }

  const section: z.ZodType = aeoFinalCopyDraftSchema.shape.sections.valueType;

  return aeoFinalCopyDraftSchema.extend({
    sections: z
      .object(Object.fromEntries(sectionKeys.map((key) => [key, section])))
      .strict(),
  });
};

/**
 * pendingReportCopy returns the pending shell, which shared report defaults
 * also supply (hardening spec §4.8). Completed copy compilation replaces the
 * pending prose and hero while keeping the neutral headings. Section titles
 * come from the config keys; publication still requires reviewed copy.
 */
export const pendingReportCopy = (
  config: Pick<AeoAuditConfig, 'reportKey' | 'brand' | 'sections'>,
): AeoReportCopy => {
  return {
    reportKey: config.reportKey,
    title: `${config.brand.name}: AI visibility report`,
    metaDescription: `How AI assistants answer buyer questions in ${config.brand.name}'s market.`,
    subtitle: 'Prepared by Literally.dev',
    preparedBy: 'Literally.dev',
    eyebrow: 'AEO insights',
    heading: `What AI answers say about ${config.brand.name}`,
    intro:
      'The measurement is in progress. This page fills in once the run has finished and the findings have been reviewed.',
    pendingBadge: 'Analysis in progress',
    pendingBody:
      'The measurement and its review are still in progress. Check back once the findings have been written up.',
    sections: Object.fromEntries(
      config.sections.map((section) => [
        section.key,
        {
          anchor: section.key.replaceAll('_', '-'),
          title: reportSectionTitle(section.key.replaceAll('_', ' ')),
          subtitle: '',
        },
      ]),
    ),
    methodologyNote: '',
    footerNote: '',
  };
};
