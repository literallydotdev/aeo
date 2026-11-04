import { z } from 'zod';

export const groundingSchemaVersion = 1;
export const groundingPolicyVersion = 1;
export const sourceExtractionVersion = 1;
export const adjudicationVersion = 1;

/** Retained sources a bundle holds: the session's own fetches
 * (`maxDocuments` of the research profile) plus any seeded by the host. */
export const groundingBundleSourceLimit = 24;

const id = z.string().min(1).max(200);

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const timestamp = z.iso.datetime({ offset: true });

export const productScopeSchema = z.object({
  product: z.string().min(1).max(300),
  generation: z.string().max(300).nullable(),
  version: z.string().max(200).nullable(),
  applicableAt: timestamp.nullable(),
});

export const proposedProductFactSchema = z.object({
  proposition: z.string().min(1).max(2000),
  scope: productScopeSchema,
  category: z.enum([
    'identity',
    'lifecycle',
    'compatibility',
    'capability',
    'other',
  ]),
  sourceUrls: z.array(z.string().url().max(4096)).max(4),
});

export type ProposedProductFact = z.infer<typeof proposedProductFactSchema>;

export const sourceReferenceSchema = z.object({ sourceId: id, passageId: id });

export const sourcePassageSchema = z.object({
  id,
  text: z.string().min(1).max(16_384),
  digest: digestSchema,
});

export const groundingSourceSchema = z.object({
  id,
  requestedUrl: z.string().url().max(4096),
  finalUrl: z.string().url().max(4096),
  title: z.string().max(500),
  publisher: z.string().max(300),
  provenance: z.enum(['first_party', 'third_party', 'unknown']),
  fetchedAt: timestamp,
  sourceDate: timestamp.nullable(),
  documentDigest: digestSchema,
  retainedDigest: digestSchema,
  passages: z.array(sourcePassageSchema).min(1).max(32),
  extractionVersion: z.literal(sourceExtractionVersion),
  truncated: z.boolean(),
});

export const unresolvedReasonSchema = z.enum([
  'not_in_sources',
  'product_ambiguous',
  'time_ambiguous',
  'sources_conflict',
  'retrieval_failed',
  'truncated_evidence',
  'budget_exhausted',
  'provider_unavailable',
  /** The run request disabled research (`grounding: extraction_only`). */
  'not_researched',
  'outside_scope',
  'overflow',
]);

export const productFactSchema = z.object({
  id,
  proposition: z.string().min(1).max(2000),
  scope: productScopeSchema,
  references: z.array(sourceReferenceSchema).max(24),
  status: z.enum(['supported', 'unresolved']),
  reason: z.string().min(1).max(3000),
});

export const answerOccurrenceSchema = z
  .object({
    answerId: id,
    runId: id,
    section: id,
    promptId: id,
    surface: id,
    runIndex: z.number().int().nonnegative(),
    capturedAt: timestamp.nullable(),
    answerDigest: digestSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(8000),
  })
  .refine((value) => value.end > value.start, 'Answer span must be nonempty');
export const claimCandidateSchema = z.object({
  id,
  proposition: z.string().min(1).max(2000),
  scope: productScopeSchema,
  category: z.enum([
    'identity',
    'lifecycle',
    'compatibility',
    'capability',
    'other',
  ]),
  occurrences: z.array(answerOccurrenceSchema).max(1000),
  disposition: z.enum(['selected', 'duplicate', 'outside_scope', 'overflow']),
  duplicateOf: id.nullable(),
  priority: z.number().int().nonnegative(),
});

const assessmentBase = {
  claimId: id,
  scope: productScopeSchema,
  explanation: z.string().min(1).max(3000),
  sourceBundleDigest: digestSchema,
  digest: digestSchema,
};

export const claimAssessmentSchema = z.discriminatedUnion('verdict', [
  z.object({
    ...assessmentBase,
    verdict: z.literal('supported'),
    references: z.array(sourceReferenceSchema).min(1).max(24),
  }),
  z.object({
    ...assessmentBase,
    verdict: z.literal('contradicted'),
    references: z.array(sourceReferenceSchema).min(1).max(24),
    incompatibleProposition: z.string().min(1).max(2000),
  }),
  z.object({
    ...assessmentBase,
    verdict: z.literal('unresolved'),
    references: z.array(sourceReferenceSchema).max(24),
    reason: unresolvedReasonSchema,
  }),
]);

export const researchStopReasonSchema = z.enum([
  'evidence_ready',
  'sources_exhausted',
  'no_progress',
  'budget_exhausted',
  'deadline',
  'provider_unavailable',
  /** No research session ran: the run request asked for extraction only. */
  'research_disabled',
]);

export const groundingCoverageSchema = z.object({
  extractionStopReason: z
    .enum([
      'complete',
      'provider_unavailable',
      'budget_exhausted',
      'inventory_limit',
    ])
    .optional(),
  suppliedAnswers: z.number().int().nonnegative(),
  extractedAnswers: z.number().int().nonnegative(),
  truncatedAnswers: z.number().int().nonnegative(),
  selectedCandidates: z.number().int().nonnegative(),
  overflowCandidates: z.number().int().nonnegative(),
  // Claims a model proposed whose quotation could not be located in its
  // answer after bounded regeneration. They are pruned rather than failing
  // the run, and recorded here so the loss stays visible to the seal receipt
  // and status (orchestrator spec invariant 5). Absent when nothing was
  // dropped, and on bundles frozen before the fields existed.
  droppedClaims: z.number().int().positive().optional(),
  droppedClaimsByAnswer: z
    .array(z.object({ answerId: id, claims: z.number().int().positive() }))
    .max(500)
    .optional(),
  stopReason: researchStopReasonSchema,
  retrievals: z
    .array(
      z.object({
        callId: id,
        kind: z.enum(['search', 'fetch', 'read']),
        status: z.enum(['completed', 'failed', 'unknown']),
        reason: z.string().max(200).nullable(),
        sourceId: id.nullable(),
      }),
    )
    .max(200),
  gaps: z
    .array(
      z.object({
        candidateIds: z.array(id).max(40),
        reason: unresolvedReasonSchema,
      }),
    )
    .max(200),
});

export const groundingBundleSchema = z.object({
  schemaVersion: z.literal(groundingSchemaVersion),
  policyVersion: z.literal(groundingPolicyVersion),
  configIdentity: z.object({
    reportKey: id,
    configVersion: z.number().int().positive(),
  }),
  runId: id.optional(),
  reviewAsOf: timestamp,
  sources: z.array(groundingSourceSchema).max(groundingBundleSourceLimit),
  facts: z.array(productFactSchema).max(80),
  candidates: z.array(claimCandidateSchema).max(1000),
  assessments: z.array(claimAssessmentSchema).max(40),
  coverage: groundingCoverageSchema,
  adjudication: z
    .object({
      model: z.string().min(1).max(200),
      profileDigest: digestSchema,
      promptVersion: z.string().min(1).max(200),
      policyVersion: z.literal(adjudicationVersion),
      inputProjectionVersion: z.literal(2).optional(),
      // Source references the adjudicator named that no held passage matches
      // (a mistyped or invented id). They are pruned, and an assessment left
      // without a citation becomes `unresolved: not_in_sources`, rather than
      // failing the run; the count keeps the loss visible, as `droppedClaims`
      // does for extraction. It lives here, not in the coverage the source
      // bundle digest seals, because pruning happens after that freeze.
      // Absent when nothing was pruned, and on bundles frozen before it.
      droppedReferences: z.number().int().positive().optional(),
    })
    .nullable(),
  sourceBundleDigest: digestSchema,
  digest: digestSchema,
});

export type ProductScope = z.infer<typeof productScopeSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type GroundingSource = z.infer<typeof groundingSourceSchema>;
export type ProductFact = z.infer<typeof productFactSchema>;
export type AnswerOccurrence = z.infer<typeof answerOccurrenceSchema>;
export type ClaimCandidate = z.infer<typeof claimCandidateSchema>;
export type ClaimAssessment = z.infer<typeof claimAssessmentSchema>;
export type GroundingCoverage = z.infer<typeof groundingCoverageSchema>;
export type GroundingBundle = z.infer<typeof groundingBundleSchema>;
export type ResearchStopReason = z.infer<typeof researchStopReasonSchema>;
export type UnresolvedReason = z.infer<typeof unresolvedReasonSchema>;

export type SavedAnswer = {
  id: string;
  runId: string;
  section: string;
  promptId: string;
  surface: string;
  runIndex: number;
  capturedAt: string | null;
  text: string;
  digest: string;
};
