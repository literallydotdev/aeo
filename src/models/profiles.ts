import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../lib/canonical-json';

// ============================================================================
// A model profile: the pinned settings of every text role a run's host
// calls use, and of the Codex stages. The engine validates and digests
// profiles; it does not choose them. A local run builds its own from
// audit.json's `model` (src/models/local-profile.ts); a host that runs the
// engine as a library passes its own profile in.
//
// Profiles are persisted with every run, resolved once and frozen, so the
// schema only ever widens: a stored profile parses, and digests, exactly as
// it did when it was admitted.
// ============================================================================

/** A profile's ID: whatever its author named it. */
export const internalModelProfileIdSchema = z.string().min(1);
export type InternalModelProfileId = z.infer<
  typeof internalModelProfileIdSchema
>;

export const generationBackendSchema = z.enum([
  'claude_code',
  'codex',
  'gateway',
]);
export type GenerationBackend = z.infer<typeof generationBackendSchema>;

// Zero is a price: the gateway lists free models.
export const modelPricingSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cachedInput: z.number().nonnegative(),
  })
  .strict();

/** List prices, USD per million tokens. */
export type ModelPricing = z.infer<typeof modelPricingSchema>;

/** How hard a reasoning model is asked to think: the levels the gateway's
 * model list names and the Codex stages accept. A model offers some of
 * them; which, its catalog entry says. */
export const reasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const internalModelRoleSchema = z
  .object({
    /** The gateway model ID, such as `anthropic/claude-opus-5.5`. */
    model: z.string().min(1),
    providerOptions: z
      .object({
        openai: z
          .object({ reasoningEffort: z.literal('high') })
          .strict()
          .optional(),
        /** Ask a reasoning model to think hard. A token budget is not
         * sent: not every provider honours one. */
        gateway: z
          .object({
            reasoning: z.union([
              z.object({ effort: reasoningEffortSchema }).strict(),
              /** Accepted so that a stored profile keeps parsing and
               * dispatching exactly as admitted; never built any more. */
              z.object({ max_tokens: z.number().int().positive() }).strict(),
            ]),
            /** The gateway upstream routes a role is restricted to, when
             * not every route of an open-weight model returns structured
             * output. Absent leaves routing to the gateway. */
            only: z.array(z.string().min(1)).min(1).max(12).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    promptVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    deadlineMs: z.number().int().positive(),
    maxInputTokens: z.number().int().positive().max(100_000),
    maxOutputTokens: z.number().int().positive(),
    /** How many items one batched call may carry, when the model wants a
     * narrower batch than the call site's own default. Absent leaves that
     * default. */
    maxItemsPerCall: z.number().int().positive().optional(),
    pricingUsdPerMillion: modelPricingSchema,
  })
  .strict();
export type InternalModelRoleConfig = z.infer<typeof internalModelRoleSchema>;

/** The model the Codex stages run on, through the gateway: part of every
 * stage's inputs digest and of the run's method. */
export const codexStageModelSchema = z
  .object({
    model: z.string().min(1),
    reasoningEffort: reasoningEffortSchema,
    /** The context window Codex must be told: it has no metadata for
     * gateway models and otherwise compacts a session at its own default. */
    contextWindow: z.number().int().positive(),
    pricingUsdPerMillion: modelPricingSchema,
  })
  .strict();
export type CodexStageModel = z.infer<typeof codexStageModelSchema>;

export const researchSearchProviderSchema = z.enum([
  'disabled',
  'dataforseo-google-organic-v1',
]);
export const internalModelProfileSchema = z
  .object({
    id: internalModelProfileIdSchema,
    version: z.literal(1),
    pricingCheckedAt: z.iso.date(),
    searchProvider: researchSearchProviderSchema,
    roles: z
      .object({
        analyzer: internalModelRoleSchema,
        perception: internalModelRoleSchema,
        research: internalModelRoleSchema,
        adjudication: internalModelRoleSchema,
        premiseVerifier: internalModelRoleSchema,
        author: internalModelRoleSchema,
        copy: internalModelRoleSchema,
        domainClassifier: internalModelRoleSchema,
        // Missing on stored profiles: optional enrichment never rewrites pins.
        logoDiscovery: internalModelRoleSchema.optional(),
        competitorClassifier: internalModelRoleSchema.optional(),
        /** Retired roles, still accepted so stored profiles parse unchanged
         * on resume. No new profile resolves them. */
        scrutiny: internalModelRoleSchema.optional(),
        repairPlanner: internalModelRoleSchema.optional(),
        visualReviewer: internalModelRoleSchema.optional(),
      })
      .strict(),
    /** The Codex stages' model. Absent on profiles pinned before the stage
     * model became part of the profile; their host supplies it. */
    stages: codexStageModelSchema.optional(),
  })
  .strict();
export type InternalModelProfile = z.infer<typeof internalModelProfileSchema>;
export type InternalModelRole = keyof InternalModelProfile['roles'];

export const internalModelProfileDigest = (
  profile: InternalModelProfile,
): string => {
  return createHash('sha256')
    .update(canonicalJson(internalModelProfileSchema.parse(profile)))
    .digest('hex');
};

export const internalModelRoleDigest = (
  roleConfig: InternalModelRoleConfig,
): string => {
  return createHash('sha256')
    .update(canonicalJson(internalModelRoleSchema.parse(roleConfig)))
    .digest('hex');
};
