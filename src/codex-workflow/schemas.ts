import { z } from 'zod';
import { aeoFinalCopyDraftSchema } from '../agents/copy-schema';
import { authorNotesSchema, authorOutputSchema } from '../agents/author-schema';

// ============================================================================
// The stage outputs of the Codex workflow (specs/aeo-codex-workflow-spec.md
// §4). Each has two forms: the JSON schema derived from it is written to
// SCHEMA/<stage>.json for the model to read (Codex runs without a
// structured-output mode; the model writes its own output file), and the
// zod schema is what the host parses the OUT file with. Rows are keyed by the answer file they
// judge, so the host can check completeness against ANSWERS/ and quote
// evidence against the file it names.
// ============================================================================

const positionSchema = z.enum(['primary', 'secondary', 'listed', 'absent']);

export const analyzeRowSchema = z
  .object({
    file: z.string().min(1).describe('The ANSWERS/ file this row judges'),
    prospectMentioned: z
      .boolean()
      .describe(
        'True only when the answer names the measured product itself, not a parent brand, a runtime it is built on, or a cited source',
      ),
    prospectPosition: positionSchema,
    prospectSentiment: z
      .enum(['positive', 'neutral', 'negative'])
      .describe(
        'How the answer speaks of the measured product; neutral when absent',
      ),
    contextSnippet: z
      .string()
      .describe('The sentence around the mention; empty when absent'),
    competitorMentions: z.array(
      z
        .object({
          domain: z
            .string()
            .describe(
              'A configured competitor domain, exactly as in CONFIG.json',
            ),
          mentioned: z.boolean(),
          position: positionSchema,
        })
        .strict(),
    ),
    mentionedBrands: z
      .array(
        z
          .object({
            name: z.string().min(1),
            domain: z.string().nullable(),
          })
          .strict(),
      )
      .describe(
        'Every company, product or brand the answer body recommends or names; never a publisher that appears only in the sources block',
      ),
  })
  .strict();

export const analyzeOutputSchema = z
  .object({ rows: z.array(analyzeRowSchema).min(1) })
  .strict();
export type AnalyzeOutput = z.infer<typeof analyzeOutputSchema>;

/** A change a later stage makes to an earlier stage's output, applied by
 * the host to that OUT file and kept as the audit trail. */
export const correctionSchema = z
  .object({
    stage: z
      .enum(['analyze', 'qualify'])
      .describe('The stage whose output is corrected'),
    file: z
      .string()
      .min(1)
      .describe('The ANSWERS/ file whose row is corrected'),
    field: z
      .string()
      .min(1)
      .describe('The row field, e.g. prospectMentioned or mentionedBrands'),
    // JSON text, not a free value: the structured-output schema needs a
    // type on every property, and a correction can carry any row field.
    from: z.string().describe('The previous value, as JSON text'),
    to: z.string().describe('The corrected value, as JSON text'),
    reason: z.string().min(1).max(600),
  })
  .strict();
export type Correction = z.infer<typeof correctionSchema>;

export const qualificationQuoteMaxLength = 400;

export const qualifyRowSchema = z
  .object({
    file: z.string().min(1),
    qualifiedCompetitors: z.array(
      z
        .object({
          name: z
            .string()
            .min(1)
            .describe('One entry per alternative; the full product name'),
          domain: z.string().nullable(),
          quote: z
            .string()
            .min(1)
            .max(qualificationQuoteMaxLength)
            .describe(
              'Verbatim text from the answer body showing it as a buyer alternative; never from the sources block',
            ),
        })
        .strict(),
    ),
  })
  .strict();

export const qualifyOutputSchema = z
  .object({
    rows: z.array(qualifyRowSchema),
    corrections: z
      .array(correctionSchema)
      .describe('Fixes to OUT/analyze rows found while qualifying'),
  })
  .strict();
export type QualifyOutput = z.infer<typeof qualifyOutputSchema>;

/** A problem this pass saw and did not fix: the next pass starts here. */
export const unresolvedProblemSchema = z
  .object({
    criterionId: z.string().min(1),
    // `host` is the host's own entry: a batch the reviewer never returned.
    stage: z.enum(['analyze', 'qualify', 'write', 'host']),
    file: z
      .string()
      .nullable()
      .describe('The ANSWERS/ file it is about, when one'),
    problem: z
      .string()
      .min(1)
      .max(2000)
      .describe('The defect, stated; never a check that found none'),
    evidence: z
      .string()
      .min(1)
      .max(600)
      .describe('The words in the answer or output that show it'),
    whyNotFixed: z.string().min(1).max(600),
  })
  .strict();

export const reviewOutputSchema = z
  .object({
    verdict: z
      .enum(['accepted', 'needs_another_pass'])
      .describe(
        'accepted only when every criterion passes after your fixes; otherwise another scrutiny pass follows, starting from your corrections and notes',
      ),
    criteria: z.array(
      z
        .object({
          criterionId: z.string().min(1),
          outcome: z.enum(['pass', 'fail']),
        })
        .strict(),
    ),
    corrections: z
      .array(correctionSchema)
      .describe('Every fix the review made to earlier outputs'),
    unresolved: z
      .array(unresolvedProblemSchema)
      .describe('Problems this pass saw and did not fix; empty when accepted'),
  })
  .strict();
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/** The copy draft the write stage produces: the pinned final draft
 * contract (hero, one narrative intro, empty section subtitles,
 * confidence), validated by the host's copy validation afterwards. */
export const writeOutputSchema = aeoFinalCopyDraftSchema;
export type WriteOutput = z.infer<typeof writeOutputSchema>;

/** The author stage's output (specs/aeo-codex-author-spec.md §3): the
 * config draft and the notes, written by the `submit` tool. */
export const authorStageOutputSchema = z
  .object({ config: authorOutputSchema, notes: authorNotesSchema })
  .strict();
export type AuthorStageOutput = z.infer<typeof authorStageOutputSchema>;

export const stageSchemas = {
  analyze: analyzeOutputSchema,
  qualify: qualifyOutputSchema,
  review: reviewOutputSchema,
  write: writeOutputSchema,
  author: authorStageOutputSchema,
} as const;
export type StageName = keyof typeof stageSchemas;

export const isStageName = (name: string): name is StageName => {
  return Object.hasOwn(stageSchemas, name);
};

/** The workflow an admission is priced against; a deployment that changes
 * what a run produces bumps it, and the job refuses to continue an
 * execution admitted for another. */
export const workflowVersion = 1;

/** The host rules behind each stage, one number per stage: bumping one
 * reruns that stage and its dependents on resume, nothing else. A prompt or
 * schema change is already in the stage's inputs digest and needs no bump. */
export const stageVersions: Record<StageName, number> = {
  analyze: 2,
  qualify: 3,
  review: 1,
  write: 1,
  author: 1,
};

/** The JSON schema written to SCHEMA/<stage>.json for the model to read;
 * also part of the stage's inputs digest and session contract. */
export const stageJsonSchema = (stage: StageName): unknown => {
  return z.toJSONSchema(stageSchemas[stage], { target: 'draft-7' });
};
