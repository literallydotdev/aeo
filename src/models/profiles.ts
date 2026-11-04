import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../lib/canonical-json';
import { getEnvironment } from '../lib/env';

/** Profile IDs are persisted on every run and pipeline, so none is ever
 * renamed or removed. The `-harness-` IDs date from the journaled harness
 * loop; since 2026-09-13 they resolve the same roles as their `-grounding-`
 * siblings (the review roles that set them apart are retired). */
export const internalModelProfileIdSchema = z.enum([
  'opus-grounding-v1',
  'astra-grounding-v1',
  'opus-harness-v1',
  'astra-harness-v1',
  // GLM 5.3 through the gateway for every text role, domain classification
  // included, and Kimi K3 for logo discovery. An evaluation profile, not
  // the default.
  'glm-harness-v1',
  // DeepSeek V4.1 Flash through the gateway for every text role, Kimi K3
  // for logo discovery. The profile every admission pins (codexRunnerProfile).
  'deepseek-harness-v1',
  // The same bulk roles on DeepSeek, with the premise verifier on Opus:
  // schema compliance and reasoning quality where a refused verdict costs a
  // copy generation (2026-09-12).
  'deepseek-harness-v2',
]);
export type InternalModelProfileId = z.infer<
  typeof internalModelProfileIdSchema
>;
export const defaultInternalModelProfile: InternalModelProfileId =
  'astra-grounding-v1';

/** The profile every admission pins, whatever the request named: every
 * role, the copy premise verifier included, resolves to DeepSeek, so no
 * judgment lands on a premium model (Andrei, 2026-09-13) and the copy
 * receipt matches the role the publication gate re-checks. */
export const codexRunnerProfile: InternalModelProfileId = 'deepseek-harness-v1';

/** The profile an operator configured for the host model steps of the local
 * Codex workflow: `AEO_MODEL_PROFILE` (its older name
 * `AEO_INTERNAL_MODEL_PROFILE` still reads), validated so a typo fails at
 * startup. Pipeline admissions do not read it; they pin codexRunnerProfile. */
export const configuredModelProfileId = (
  env: Record<string, string | undefined> = getEnvironment(),
): InternalModelProfileId => {
  return internalModelProfileIdSchema.parse(
    env.AEO_MODEL_PROFILE ??
      env.AEO_INTERNAL_MODEL_PROFILE ??
      defaultInternalModelProfile,
  );
};

export const generationBackendSchema = z.enum([
  'claude_code',
  'codex',
  'gateway',
]);
export type GenerationBackend = z.infer<typeof generationBackendSchema>;

export const internalModelRoleSchema = z
  .object({
    model: z.enum([
      'anthropic/claude-opus-4.6',
      'openai/gpt-6-astra',
      'zai/glm-5.3',
      'moonshotai/kimi-k3',
      'deepseek/deepseek-v4.1-flash',
      'anthropic/claude-opus-5',
    ]),
    providerOptions: z
      .object({
        openai: z
          .object({ reasoningEffort: z.literal('high') })
          .strict()
          .optional(),
        /** Ask the reasoning families to think hard. These models are not
         * the strongest available, so depth is worth its tokens; streaming
         * keeps a long generation inside the gateway's limits. A token
         * budget is deliberately NOT sent: GLM ignores it (measured). */
        gateway: z
          .object({
            reasoning: z.union([
              z.object({ effort: z.literal('high') }).strict(),
              /** Pinned before 2026-09-11, while the budget was believed to
               * be honoured. GLM ignores it, so it is no longer emitted, but
               * a stored profile must keep parsing and dispatching exactly as
               * admitted. */
              z.object({ max_tokens: z.number().int().positive() }).strict(),
            ]),
            /** The gateway load-balances an open-weight model across
             * upstream providers, and not every upstream honours a JSON
             * response schema: on 2026-09-12 the `zai` and `novita` routes
             * for GLM 5.3 dropped the schema and every structured call
             * failed as `StructuredOutputMissingError`, while `baseten`
             * and `fireworks` answered in a second. The pinned routes are
             * the ones probed to return objects; the gateway still balances
             * among them. Absent on profiles pinned before the routing pin. */
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
    /** How many items one batched call may carry, when the pinned model
     * wants a narrower batch than the call site's own default. Absent leaves
     * that default, so profiles pinned before this keep their exact digest. */
    maxItemsPerCall: z.number().int().positive().optional(),
    pricingUsdPerMillion: z
      .object({
        input: z.number().positive(),
        output: z.number().positive(),
        cachedInput: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type InternalModelRoleConfig = z.infer<typeof internalModelRoleSchema>;
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
        /** Retired roles, still accepted so profiles pinned before their
         * retirement parse unchanged on resume: the visual reviewer went with
         * the model-backed visual review (11 September 2026), the scrutiny
         * and repair-planner roles with the journaled harness loop
         * (13 September 2026). No new profile resolves them. */
        scrutiny: internalModelRoleSchema.optional(),
        repairPlanner: internalModelRoleSchema.optional(),
        visualReviewer: internalModelRoleSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type InternalModelProfile = z.infer<typeof internalModelProfileSchema>;
export type InternalModelRole = keyof InternalModelProfile['roles'];

/** The model family behind a role. A profile picks one family for its text
 * roles, one for the vision role (logo discovery) and one for domain
 * classification. Gateway list prices, USD per million tokens, checked on
 * `pricingCheckedAt`. */
type ModelFamily = 'opus' | 'astra' | 'glm' | 'kimi' | 'deepseek' | 'opus5';
const familyModels: Record<ModelFamily, InternalModelRoleConfig['model']> = {
  opus: 'anthropic/claude-opus-4.6',
  astra: 'openai/gpt-6-astra',
  glm: 'zai/glm-5.3',
  kimi: 'moonshotai/kimi-k3',
  deepseek: 'deepseek/deepseek-v4.1-flash',
  /** The judgment family of `deepseek-harness-v2` (Andrei, 2026-09-12):
   * Opus 5 at high adaptive effort. Opus 4.6 stays pinned for the older
   * profiles' stored meaning. */
  opus5: 'anthropic/claude-opus-5',
};
/** Gateway upstream routes that return structured output for the open-weight
 * families, probed 2026-09-12 with a one-object request per route (see the
 * `only` option above). Kimi is left to the gateway's own routing. */
const familyRoutes: Partial<Record<ModelFamily, readonly string[]>> = {
  glm: ['baseten', 'fireworks', 'deepinfra', 'friendli'],
  // DeepInfra answered the one-object probe but refused the evidence
  // reviewer's request outright (finish reason "error", no output, three
  // times in a row, 2026-09-12); Baseten reported capacity errors under
  // restriction. The first-party route and Fireworks carried every stage.
  deepseek: ['deepseek', 'fireworks'],
};

const familyPricing: Record<
  ModelFamily,
  InternalModelRoleConfig['pricingUsdPerMillion']
> = {
  opus: { input: 5, output: 25, cachedInput: 0.5 },
  astra: { input: 10, output: 50, cachedInput: 1 },
  glm: { input: 1.4, output: 4.4, cachedInput: 0.14 },
  kimi: { input: 3, output: 15, cachedInput: 0.3 },
  deepseek: { input: 0.3, output: 1.2, cachedInput: 0.03 },
  opus5: { input: 5, output: 25, cachedInput: 0.5 },
};

/** A profile ID names the family behind its text roles and its pin
 * generation: `<family>-<grounding|harness>-v<n>`. The middle word is
 * history (see the ID list); reading the ID is the single place the family
 * is decided, so an ID whose shape says nothing is refused rather than
 * quietly resolved onto Opus. */
const profileIdPattern =
  /^(opus|astra|glm|deepseek)-(grounding|harness)-v(\d+)$/;

const textFamilies = [
  'opus',
  'astra',
  'glm',
  'deepseek',
] as const satisfies readonly ModelFamily[];

const isTextFamily = (
  value: unknown,
): value is (typeof textFamilies)[number] => {
  return textFamilies.some((family) => family === value);
};

export const parseInternalModelProfileId = (
  id: string,
): {
  family: ModelFamily;
  version: number;
} => {
  const match = profileIdPattern.exec(id);
  // The first group admits only the text families.
  const family = match?.[1];

  if (!match || !isTextFamily(family)) {
    throw new Error(`internal_model_profile_unrecognized: ${id}`);
  }

  return { family, version: Number(match[3]) };
};

/** Families whose hidden reasoning is billed inside the output allowance, so
 * a cap sized for the answer alone leaves nothing to answer with. Measured on
 * GLM through the gateway, 2026-09-11: thinking is 85-93% of what they
 * generate, at 67-100 tokens per second.
 *
 * They are given the answer's pinned room plus a reasoning allowance. That
 * allowance is a SIZING input, not a token budget sent to the provider: the
 * gateway's `reasoning.max_tokens` is not honoured by GLM. Probed directly,
 * a 512-token budget produced 12,946 reasoning tokens where no control at all
 * produced 11,153. These roles ask for high effort instead, because depth is
 * worth its tokens on a model this size, and wall-clock is bounded by
 * streaming the request rather than by starving the thinking. */
const reasoningOutputFamilies: readonly ModelFamily[] = [
  'glm',
  'kimi',
  'deepseek',
];

/** Families whose thinking is billed inside the output allowance. Opus 5
 * thinks adaptively at the requested effort and Anthropic counts it as
 * output, so the answer's room gets the same fixed allowance; it is not a
 * slow open-weight family, so its deadlines stay at the spec ceilings. */
const thinkingInOutputFamilies: readonly ModelFamily[] = [
  ...reasoningOutputFamilies,
  'opus5',
];

/** Room to think, on top of whatever the answer itself is allowed.
 *
 * This is one number for every reasoning role rather than a multiple of the
 * answer's size, because how hard a task is to think through has little to do
 * with how long its answer runs. Scaling it by answer size gave the premise
 * verifier, which returns a short verdict after difficult reasoning, the
 * smallest allowance of any role; on 2026-09-11 it exhausted 24,576 tokens
 * and emitted nothing, while copy spent 34,425 thinking and finished.
 *
 * The binding limit is now how long one stream may last, roughly 785 seconds,
 * which at the measured 84 tokens per second is about 66,000 tokens. */
const reasoningBudgetTokens = 32_768;

const getProviderOptions = (
  family: ModelFamily,
  isReasoning: boolean,
): InternalModelRoleConfig['providerOptions'] => {
  if (family === 'astra') {
    return { openai: { reasoningEffort: 'high' } };
  }

  if (!isReasoning && family !== 'opus5') {
    return {};
  }

  const routes = familyRoutes[family];

  return {
    gateway: {
      reasoning: { effort: 'high' },
      ...(routes ? { only: [...routes] } : {}),
    },
  };
};

const promptVersions: Partial<Record<InternalModelRole, number>> = {
  copy: 5,
  premiseVerifier: 5,
  analyzer: 3,
  research: 2,
  adjudication: 2,
  competitorClassifier: 2,
  domainClassifier: 2,
};

const schemaVersions: Partial<Record<InternalModelRole, number>> = {
  copy: 3,
  adjudication: 2,
  premiseVerifier: 2,
};

type CreateRoleConfigOptions = {
  maxOutputTokens?: number;
  deadlineMs?: number;
  /** Items per batched call for the reasoning families only. They pay for a
   * wide batch twice, in output tokens and in wall-clock, and a narrow batch
   * also makes any retry cheap. The other families keep their call site's
   * default, which leaves their pinned roles byte-identical. */
  reasoningItemsPerCall?: number;
};

const createRoleConfig = (
  name: InternalModelRole,
  family: ModelFamily,
  {
    maxOutputTokens = 16_384,
    deadlineMs = 180_000,
    reasoningItemsPerCall,
  }: CreateRoleConfigOptions = {},
): InternalModelRoleConfig => {
  const reasoning = reasoningOutputFamilies.includes(family);
  const reasoningBudget = thinkingInOutputFamilies.includes(family)
    ? reasoningBudgetTokens
    : 0;

  // The cap is the answer's pinned room plus that budget, so it describes a
  // generation the provider can actually deliver.
  const output = maxOutputTokens + reasoningBudget;
  // Thinking takes wall-clock too: GLM overran the copy role's five-minute
  // deadline on 2026-09-11 while still reasoning. The same families get
  // proportionally longer to finish, capped so a stall still ends the call.
  const deadline = reasoning ? Math.min(deadlineMs * 3, 900_000) : deadlineMs;

  const roleConfig: InternalModelRoleConfig = {
    model: familyModels[family],
    providerOptions: getProviderOptions(family, reasoning),
    // premiseVerifier v4/v2 (2026-09-12): the verdict carries an explicit
    // `passed` flag and the prompt forbids placeholder text in `errors`.
    // premiseVerifier v5 (2026-09-13): an irrelevant but supported premise
    // no longer fails a block on its own.
    // copy v4 (2026-09-12): COPY_RULES.md now states the verifier's own
    // refusals (buyer behaviour, positioning, rankings, unmeasured
    // qualities, scope words, publisher), which the previous rules invited.
    // analyzer v2 (2026-09-12): the prompt states the attribution rule the
    // reviewers enforce, so an alias behind another vendor's product is not
    // a mention. Until then every "Deno-based" phrase was credited to Deno
    // Deploy and every run blocked on false_product_attribution.
    // copy v5 and analyzer v3 (2026-09-12): both prompts now carry the
    // producer guidance of the criterion registry, the single source the
    // reviewers judge by.
    // competitorClassifier and domainClassifier v2 (2026-09-12): both
    // prompts carry the registry's enrichment guidance (umbrella brands,
    // duplicates, named recommendations, source categories).
    // COPY_RULES.md change without a copy bump (2026-09-13): the hero title
    // is asked for as one sentence in sentence case, after a container run
    // produced a title-case fragment. The Codex write stage digests
    // src/author/COPY_RULES.md itself, and a bump here would change the digest of every
    // stored profile ID, which the pin test below forbids.
    promptVersion: `${name}-grounding-v${promptVersions[name] ?? 1}`,
    schemaVersion: `${name}-v${schemaVersions[name] ?? 1}`,
    deadlineMs: deadline,
    maxInputTokens: 80_000,
    maxOutputTokens: output,
    ...(reasoning && reasoningItemsPerCall !== undefined
      ? { maxItemsPerCall: reasoningItemsPerCall }
      : {}),
    pricingUsdPerMillion: familyPricing[family],
  };

  return roleConfig;
};

const pricingCheckedDates: Partial<Record<ModelFamily, string>> = {
  deepseek: '2026-09-12',
  glm: '2026-09-11',
};

/**
 * resolveInternalModelProfile runs once at admission; the complete snapshot is
 * persisted for every retry.
 */
export const resolveInternalModelProfile = (
  id: InternalModelProfileId = defaultInternalModelProfile,
  env: Record<string, string | undefined> = getEnvironment(),
): InternalModelProfile => {
  const parsedId = internalModelProfileIdSchema.parse(id);
  const { family, version } = parseInternalModelProfileId(parsedId);
  // deepseek-harness-v2: the premise verifier moves to Opus. A refused
  // verdict costs a copy generation, so schema compliance and reasoning
  // quality are worth the price there; the bulk roles stay on DeepSeek,
  // where volume is the cost.
  const judgment: ModelFamily =
    family === 'deepseek' && version >= 2 ? 'opus5' : family;
  // The Astra and Opus profiles keep logo discovery and domain classification
  // on Opus exactly as pinned; the open-weight evaluation profiles move both
  // off Opus.
  const openWeight = family === 'glm' || family === 'deepseek';
  const vision: ModelFamily = openWeight ? 'kimi' : 'opus';
  const classification: ModelFamily = openWeight ? family : 'opus';
  // Reasoning models take longer per call; the Opus deadlines stay as pinned.
  const reasoning = family !== 'opus';

  return internalModelProfileSchema.parse({
    id,
    version: 1,
    pricingCheckedAt: pricingCheckedDates[family] ?? '2026-09-09',
    searchProvider: researchSearchProviderSchema.parse(
      env.AEO_RESEARCH_SEARCH_PROVIDER ??
        (env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD
          ? 'dataforseo-google-organic-v1'
          : 'disabled'),
    ),
    roles: {
      // Batched roles carry a narrower ceiling for the reasoning families.
      // Five answers in one analyzer call ran past the transport's five
      // minutes on GLM (2026-09-11) after spending most of the allowance on
      // thinking; each call now covers a fraction of the work instead.
      analyzer: createRoleConfig('analyzer', family, {
        maxOutputTokens: 16_384,
        deadlineMs: reasoning ? 600_000 : 180_000,
        reasoningItemsPerCall: 2,
      }),
      // Perception's pin also governs claim extraction, which shares the
      // role and batches three answers of its own; streaming carries a call
      // that size comfortably, so this only narrows perception itself.
      perception: createRoleConfig('perception', family, {
        maxOutputTokens: 16_384,
        deadlineMs: 300_000,
        reasoningItemsPerCall: 5,
      }),
      research: createRoleConfig('research', family, {
        maxOutputTokens: 4096,
        deadlineMs: 60_000,
      }),
      // Bounded by verdicts per call, so a wide claim set splits instead of
      // pushing the retrieved evidence out of the prompt.
      adjudication: createRoleConfig('adjudication', family, {
        maxOutputTokens: 16_384,
        deadlineMs: 300_000,
        reasoningItemsPerCall: 8,
      }),
      // One judgement per call. This role carries the longest instructions in
      // the system and is asked to enumerate every explicit and implied
      // premise; measured 2026-09-11, three of four calls holding several
      // blocks ran to their cap on reasoning alone and returned nothing,
      // while the one that finished had spent 22,899 tokens thinking.
      premiseVerifier: createRoleConfig('premiseVerifier', judgment, {
        maxOutputTokens: 8192,
        deadlineMs: 180_000,
        reasoningItemsPerCall: 1,
      }),
      author: createRoleConfig('author', family, {
        maxOutputTokens: 24_576,
        deadlineMs: 300_000,
      }),
      copy: createRoleConfig('copy', family, {
        maxOutputTokens: 24_576,
        deadlineMs: 300_000,
      }),
      domainClassifier: createRoleConfig('domainClassifier', classification, {
        maxOutputTokens: 16_384,
        deadlineMs: 180_000,
        reasoningItemsPerCall: 25,
      }),
      competitorClassifier: createRoleConfig('competitorClassifier', family, {
        maxOutputTokens: 8192,
        deadlineMs: 300_000,
      }),
      logoDiscovery: {
        ...createRoleConfig('logoDiscovery', vision, {
          maxOutputTokens: 1024,
          deadlineMs: 60_000,
        }),
        promptVersion: 'logoDiscovery-grounding-v2',
        schemaVersion: 'logoDiscovery-v2',
        maxInputTokens: 24_000,
      },
    },
  });
};

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
