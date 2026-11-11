import { z } from 'zod';
import { questionSetNameSchema } from './report/core/progress-schema';
import {
  brandSchema,
  aeoPromptSchema,
  aeoSurfaceSchema,
  consumerSurfaces,
  customSurfaceKeyPattern,
  customSurfaceRunCount,
  isAgentSurface,
  isCustomSurface,
  sourceCategorySchema,
  surfaceRunCounts,
  type AeoSurface,
  type AeoApiSurface,
} from './report/core/schema';
import { coverageThresholdsSchema } from './coverage-schema';
import { groundingBundleSchema } from './grounding/schema';
import { internalModelProfileSchema } from './models/profiles';
import { modelBudgetLimitsSchema } from './models/accounting';
import { probeLimitsSchema } from './probes/limits';

export * from './report/core/schema';

export const aeoSectionConfigSchema = z.object({
  // Free string — section keys are per-client, no shared enum to extend.
  key: z.string().min(1),
  prompts: z.array(aeoPromptSchema).min(1),
  // Per-section override for reports whose sections measure different
  // markets. Omitted → the report-level set (the union shown on the page).
  competitors: z.array(brandSchema).optional(),
});

// Measurement depth: how many times each prompt is asked on a surface. A
// report may measure fewer prompts more deeply. The ceiling keeps one
// typo from planning thousands of paid answers; maxPlannedUnits and the
// budget still bound the run as a whole.
const maxRunsPerPrompt = 25;

const runsPerPromptSchema = z.number().int().min(1).max(maxRunsPerPrompt);

// Agent probe volume (spec §5, revised 2026-08-21): defaults are the
// canonical 2 runs per prompt over every prompt. Changing either value after
// the first committed run is an agent-baseline reset — call it out in the
// methodology note.
export const agentProbeConfigSchema = z.object({
  // Runs per prompt per agent surface.
  runsPerPrompt: runsPerPromptSchema.default(2),
  // Cap on how many of each section's prompts get agent probes — the FIRST N
  // prompts in config order, so the subset is stable across runs. Omitted =
  // all prompts.
  maxPromptsPerSection: z.number().int().min(1).optional(),
});

export type AgentProbeConfig = z.infer<typeof agentProbeConfigSchema>;

/** agentProbedPrompts is the prompts the coding agents are asked: the first
 * maxPromptsPerSection in config order, or every prompt. */
export const agentProbedPrompts = <Prompt>(
  prompts: readonly Prompt[],
  agentProbes: AgentProbeConfig,
): Prompt[] => {
  return prompts.slice(0, agentProbes.maxPromptsPerSection ?? prompts.length);
};

// Chat probe volume. Optional with no default, so a config without it parses,
// and digests, exactly as configs did before chat depth was configurable:
// bundles exported earlier still verify. Omitted = the canonical
// surfaceRunCounts (2 per surface, 1 for AI Overview and for each consumer
// app); set = that many runs on every surface asked through an API or a
// scrape. AI Overview included: each of its runs is a live search, sampling
// whether an overview appears and what it says.
export const chatProbeConfigSchema = z
  .object({ runsPerPrompt: runsPerPromptSchema })
  .strict();

export type ChatProbeConfig = z.infer<typeof chatProbeConfigSchema>;

/** chatRunsPerPrompt is how many times each prompt is asked on a chat
 * surface. */
export const chatRunsPerPrompt = (
  surface: AeoApiSurface,
  chatProbes: ChatProbeConfig | undefined,
): number => {
  return (
    chatProbes?.runsPerPrompt ??
    (isCustomSurface(surface)
      ? customSurfaceRunCount
      : surfaceRunCounts[surface])
  );
};

export type ProbeDepth = {
  agentProbes: AgentProbeConfig;
  chatProbes: ChatProbeConfig | undefined;
};

/** runsPerPromptOn is how many times each prompt is asked on a surface: the
 * depth the plan is built at, which the probe batches and every
 * planned-answer denominator must match. */
export const runsPerPromptOn = (
  surface: AeoSurface,
  depth: ProbeDepth,
): number => {
  if (isAgentSurface(surface)) {
    return depth.agentProbes.runsPerPrompt;
  }

  return chatRunsPerPrompt(surface, depth.chatProbes);
};

const ownedCompetitorDomainSchema = z
  .string()
  .trim()
  .regex(
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/,
    'Expected a domain name without a URL, path or port',
  );

/** How many custom surfaces one audit may declare. */
export const maxCustomSurfaces = 8;

// Whether the coding agents are measured (specs/aeo-surface-selection-spec
// §3.1): the author decides from who the buyers are, with the reason the
// config gate shows. The default keeps every stored config measuring all
// eight default surfaces.
const surfaceDecisionShape = {
  codingAgents: z.enum(['measure', 'skip']),
  because: z.string().trim().min(12).max(300),
};

const defaultSurfaceDecision = {
  codingAgents: 'measure',
  because:
    'Default: every surface is measured until the author decides otherwise.',
} as const;

/** The surface decision the config author makes: the coding agents, and
 * nothing else. */
export const authoredSurfacesSchema = z
  .object(surfaceDecisionShape)
  .strict()
  .prefault(defaultSurfaceDecision);

export const aeoAuditConfigSchema = z.object({
  reportKey: z.string().min(1),
  // Labels the console Dashboard's question-set selector until it adopts
  // @literally/aeo-report 0.5.0; the website no longer shows it.
  questionSetName: questionSetNameSchema.optional(),
  slug: z.string().min(1),
  brand: brandSchema,
  competitors: z.array(brandSchema).min(1),
  // Additional domains owned by the audited company, excluded only from
  // competitor qualification. This does not broaden mention/citation scoring.
  competitorQualification: z
    .object({
      ownedDomains: z.array(ownedCompetitorDomainSchema).min(1).max(20),
    })
    .strict()
    .optional(),
  sections: z.array(aeoSectionConfigSchema).min(1),
  // Defaults to the canonical volume (2 runs per prompt, all prompts) via
  // the schema — consumers read config.agentProbes directly, no fallbacks.
  // prefault({}) runs {} through the inner schema so its own defaults fill.
  agentProbes: agentProbeConfigSchema.prefault({}),
  // Read through runsPerPromptOn or chatRunsPerPrompt, which own the
  // fallback to the canonical counts.
  chatProbes: chatProbeConfigSchema.optional(),
  // Renderability targets — docs, pricing, comparison pages (§7.4).
  moneyPages: z.array(z.string().url()),
  // Grounds accuracy flagging (§7.2): claims contradicting this brief are
  // flagged for human verification.
  productBrief: z.string().min(1),
  // The custom surfaces the audit declares (open models spec §5): the plan
  // needs their IDs and the facts their labels. Their models are bindings,
  // never configuration: a model is how a surface is asked, not what is
  // measured. Absent when none is declared, so a config without them
  // parses, and digests, exactly as before.
  customSurfaces: z
    .array(
      z
        .object({
          key: z.string().regex(customSurfaceKeyPattern),
          label: z.string().trim().min(1).max(60),
        })
        .strict(),
    )
    .min(1)
    .max(maxCustomSurfaces)
    .optional(),
  surfaces: z
    .object({
      ...surfaceDecisionShape,
      // The consumer apps measured as well (method release spec §5.4), each
      // listed once. The operator's choice, never the author's. Absent when
      // none is, so a config without them parses, and digests, exactly as
      // before.
      consumerApps: z
        .array(z.enum(consumerSurfaces))
        .min(1)
        // One spelling per set of apps, so the same apps always digest
        // the same.
        .refine(
          (listed) =>
            listed.join() ===
            consumerSurfaces.filter((app) => listed.includes(app)).join(),
          {
            error: `Each consumer app is listed once, in this order: ${consumerSurfaces.join(', ')}.`,
          },
        )
        .optional(),
    })
    .strict()
    .prefault(defaultSurfaceDecision),
  productGrounding: groundingBundleSchema.optional(),
  // Per-report domain classification overrides for §7.1.
  sourceOverrides: z.record(z.string(), sourceCategorySchema).optional(),
  // Config-declared facts checked by a human, not crawled (§7.4).
  agentReadiness: z
    .object({ mcpServer: z.boolean(), llmDocs: z.boolean() })
    .optional(),
  // Google AI Overview locale; defaults ported from the console.
  geography: z.string().default('us'),
  language: z.string().default('en'),
});

export type AeoAuditConfig = z.infer<typeof aeoAuditConfigSchema>;
export type AeoAuditConfigInput = z.input<typeof aeoAuditConfigSchema>;
export type AeoSectionConfig = z.infer<typeof aeoSectionConfigSchema>;

// ---------------------------------------------------------------------------
// Section visibility (v2 superset of the console's aiSearchVisibilitySchema)
// ---------------------------------------------------------------------------
// Raw answer text is deliberately NOT part of the snapshot: full responseText
// lives in evidence chunk files referenced by `evidenceFile` (§6), keeping
// the page payload static-site-friendly.

export const checkpointMatchSchema = z.object({
  sectionKey: z.string().min(1).optional(),
  surface: aeoSurfaceSchema.optional(),
});

// Coverage gate (§4.1): per surface, captured / planned below the threshold
// blocks the write unless `allowPartial`. Defaults per §9.3: any surface at
// zero blocks, and any surface below half its plan blocks.
export { coverageThresholdsSchema } from './coverage-schema';

export {
  pipelineRequestSchema,
  pipelineCallbackSchema,
} from './workflow/schema';

export type {
  PipelineRequest,
  PipelineCallback,
  ResolvedGates,
} from './workflow/schema';

export type CoverageThresholds = z.infer<typeof coverageThresholdsSchema>;

// Cost cap default (§9.8): above the largest registered baseline (Literally,
// 285 units) with headroom for a two-section config; a plan above it fails
// before any probe is sent.
export const defaultMaxPlannedUnits = 400;

export const runRequestSchema = z.object({
  modelProfile: internalModelProfileSchema.optional(),
  modelBudget: modelBudgetLimitsSchema.optional(),
  derivedFromRunId: z.string().min(1).optional(),
  configVersion: z.number().int().positive().optional(),
  batchJobId: z.string().min(1).optional(),
  batchAttempt: z.number().int().positive().optional(),
  reportKey: z.string().min(1),
  runId: z.string().min(1),
  // Section keys to run; omitted = every section of the config.
  sections: z.array(z.string().min(1)).min(1).optional(),
  // Surfaces in scope; omitted = every surface.
  surfaces: z.array(aeoSurfaceSchema).min(1).optional(),
  // `resume` reuses stored captures and analyses; `fresh` clears both first
  // (a new baseline or a quarterly re-measurement).
  mode: z.enum(['resume', 'fresh']).default('resume'),
  // Stored captures to drop before probing, so only they re-execute.
  redo: z.array(checkpointMatchSchema).optional(),
  // Writes the snapshot despite blocking partial failures (analysis
  // failures, coverage shortfalls); the report says what is missing.
  allowPartial: z.boolean().default(false),
  // How far grounding goes. `full` extracts, researches and adjudicates the
  // claims assistants made about the product; `extraction_only` keeps the
  // claim inventory (observed-claim facts and the reviewers' evidence need
  // it) and skips research and adjudication, so the copy has no product
  // facts to state and states none. A report about measured visibility does
  // not pay minutes and a research budget for a fact check it will not use.
  grounding: z.enum(['full', 'extraction_only']).default('full'),
  coverageThresholds: coverageThresholdsSchema.prefault({}),
  maxPlannedUnits: z.number().int().positive().default(defaultMaxPlannedUnits),
  // Per-provider pool sizes (§4.5).
  limits: probeLimitsSchema.prefault({}),
});

export type RunRequest = z.infer<typeof runRequestSchema>;
export type RunRequestInput = z.input<typeof runRequestSchema>;

export const partialFailureSchema = z.object({
  step: z.string(),
  error: z.string(),
});
