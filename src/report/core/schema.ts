import { z } from 'zod';
import { retrievalCallKinds, retrievalExposures } from './retrieval';
import { allSurfaces } from './surfaces';

export const aeoSnapshotVersion = 2;

/** Ceiling on additive scrutiny rounds; the workflow loop and the stored
 * `meta.quality.reviewRounds` share it. */
export const maxReviewRounds = 5;

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------
// Constants and helpers live in the zod-free surfaces.ts (the client
// island imports them from there without dragging zod into the bundle);
// re-exported here so schema consumers see one module.

export {
  agentSurfaces,
  allSurfaces,
  chatSurfaces,
  surfaceRunCounts,
  isAgentSurface,
} from './surfaces';
export type { AeoAgentSurface, AeoChatSurface, AeoSurface } from './surfaces';

export const aeoSurfaceSchema = z.enum(allSurfaces);

// ---------------------------------------------------------------------------
// Retrieval log (retrieval-log spec §4) — the searches and fetches behind one
// answer, one shape for every surface so the page never branches on surface
// names. Constants live in the zod-free retrieval.ts (client-safe).
// ---------------------------------------------------------------------------

export {
  retrievalCallKinds,
  retrievalExposures,
  surfaceRetrievalExposure,
} from './retrieval';
export type { RetrievalCallKind, RetrievalExposure } from './retrieval';

export const retrievalCallSchema = z.object({
  kind: z.enum(retrievalCallKinds),
  // Search term for `search`; null for the URL-driven kinds.
  query: z.string().nullable(),
  // Target for fetch / open_page / find_in_page; null for `search`.
  url: z.string().nullable(),
  // URLs the call returned to the model. Null when the surface does not
  // expose results for this call (Codex, Gemini queries) or the result
  // never arrived / could not be parsed.
  resultUrls: z.array(z.string()).nullable(),
  // False when resultUrls is a cited subset rather than the full result
  // list (ChatGPT). Irrelevant when resultUrls is null.
  resultsComplete: z.boolean(),
});

export type RetrievalCall = z.infer<typeof retrievalCallSchema>;

export const retrievalLogSchema = z.object({
  exposure: z.enum(retrievalExposures),
  // In stream order. Empty is legal: the surface exposes retrieval and the
  // answer made no calls (an honest from-memory answer).
  calls: z.array(retrievalCallSchema),
});

export type RetrievalLog = z.infer<typeof retrievalLogSchema>;

// Compact per-call summary on the matrix row (§4): the presence flags the
// aggregate views read, never the result URLs themselves (those stay in the
// evidence chunk).
export const retrievalCallSummarySchema = z.object({
  kind: z.enum(retrievalCallKinds),
  query: z.string().nullable(), // search only
  url: z.string().nullable(), // fetch / open_page / find_in_page
  // search: the brand's domain is in the result set (null when the surface
  // exposes no result set, or when an incomplete result set cannot prove
  // absence). Other kinds: the opened URL is on the brand's domain.
  brandFound: z.boolean().nullable(),
  // Same rule per competitor; normalized domains.
  competitorsFound: z.array(z.string()),
  // search only; null when results are not exposed.
  resultCount: z.number().nullable(),
});

export type RetrievalCallSummary = z.infer<typeof retrievalCallSummarySchema>;

// One entry per cited URL on a run; `callIndices` (into the run's retrieval
// log) empty when the citation is unattributed.
export const citationAttributionSchema = z.array(
  z.object({ url: z.string(), callIndices: z.array(z.number().int()) }),
);

export type CitationAttribution = z.infer<typeof citationAttributionSchema>;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
// No `brand_awareness` category on purpose — those prompts pre-bias mention
// rates (console prospect-audit rule, carried over).

export const aeoPromptCategorySchema = z.enum([
  'product_recommendation',
  'industry_expert',
  'comparison',
  'problem_solving',
  'general_knowledge',
]);

export type AeoPromptCategory = z.infer<typeof aeoPromptCategorySchema>;

export const aeoPromptSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  category: aeoPromptCategorySchema,
});

export type AeoPrompt = z.infer<typeof aeoPromptSchema>;

// ---------------------------------------------------------------------------
// Citation source classification (§7.1)
// ---------------------------------------------------------------------------

export const sourceCategories = [
  'owned',
  'competitor',
  'social',
  'institutional',
  'earned',
] as const;

export const sourceCategorySchema = z.enum(sourceCategories);
export type SourceCategory = z.infer<typeof sourceCategorySchema>;

const sourceMixCountsSchema = z.object({
  owned: z.number(),
  competitor: z.number(),
  social: z.number(),
  institutional: z.number(),
  earned: z.number(),
});

export type SourceMixCounts = z.infer<typeof sourceMixCountsSchema>;

// ---------------------------------------------------------------------------

export const brandSchema = z.object({
  name: z.string(),
  domain: z.string(),
  aliases: z.array(z.string()).default([]),
});

export type AeoBrand = z.infer<typeof brandSchema>;

export const aeoMatrixRowSchema = z.object({
  promptIdx: z.number(),
  surface: aeoSurfaceSchema,
  prospectMentioned: z.boolean(),
  prospectPosition: z
    .enum(['primary', 'secondary', 'listed', 'absent'])
    .nullable(),
  contextSnippet: z.string().nullable(),
  runIndex: z.number().optional(),
  citedUrls: z.array(z.string().url()).optional(),
  mentionedBrands: z
    .array(z.object({ name: z.string(), domain: z.string().nullable() }))
    .optional(),
  // Section-aware buyer alternatives, qualified from saved answer context.
  // Absent = historical data; an empty array means none qualified. The raw
  // mentionedBrands inventory remains intact for inspecting the actual answer.
  qualifiedCompetitors: z
    .array(z.object({ name: z.string(), domain: z.string().nullable() }))
    .optional(),
  competitors: z.array(
    z.object({ domain: z.string(), mentioned: z.boolean() }),
  ),
  // Per-mention sentiment — the analyzer always extracted it; v2 persists it.
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  // Agent surfaces only: whether the CLI actually used web tools, and which
  // CLI version answered. Answers from model priors are honest data (§5).
  // Tri-state (correctness spec §3.1): true = a web search/fetch completed,
  // false = the stream was parsed and no web tool was attempted, null = the
  // run's tool events could not be parsed (or were never captured — the
  // migrated pre-fix baselines), so retrieval is unknown. Never guessed
  // from the answer text.
  usedWebSearch: z.boolean().nullable().optional(),
  agentCliVersion: z.string().optional(),
  // Retrieval log summary (retrieval-log spec §4). Both absent = the log was
  // not captured for this run (a probe that predates the spec, or a parse
  // miss) — never a from-memory claim. Present on every fresh probe,
  // `exposure: 'none'` surfaces included (with an empty call list).
  retrievalExposure: retrievalLogSchema.shape.exposure.optional(),
  retrievalCalls: z.array(retrievalCallSummarySchema).optional(),
  // Google AI Overview only (hardening spec §4.1): the SERP carried no AI
  // Overview. A captured absence — counts against share of voice — with no
  // answer text behind it. Absent on every other surface.
  noOverview: z.literal(true).optional(),
  // Path of this run's evidence chunk, relative to the report directory
  // (e.g. 'evidence/vector_search-0.json'). Null when no text was captured.
  evidenceFile: z.string().nullable().optional(),
});

export type AeoMatrixRow = z.infer<typeof aeoMatrixRowSchema>;

export const aeoVisibilitySchema = z.object({
  prompts: z.array(
    z.object({ text: z.string(), category: aeoPromptCategorySchema }),
  ),
  surfaces: z.array(aeoSurfaceSchema),
  matrix: z.array(aeoMatrixRowSchema),
  summary: z.object({
    // Headline scorecards — chat surfaces only, comparable with v1 baselines.
    // Null when the run measured no chat surfaces (agents-only iteration
    // runs): an unmeasured scope must never render as a measured 0%.
    prospectShareOfVoice: z.number().min(0).max(1).nullable(),
    prospectCitationRate: z.number().min(0).max(1).nullable(),
    // Agent scorecard pair over the agent-surface runs (Claude Code, Codex,
    // Cursor — §5). Null when the
    // agent surfaces weren't run.
    agentShareOfVoice: z.number().min(0).max(1).nullable(),
    agentCitationRate: z.number().min(0).max(1).nullable(),
    byModel: z.record(
      z.string(),
      z.object({ shareOfVoice: z.number(), citationRate: z.number() }),
    ),
    byCompetitor: z.array(
      z.object({
        domain: z.string(),
        shareOfVoice: z.number(),
        citationRate: z.number(),
      }),
    ),
    topCompetitorDomain: z.string().nullable(),
  }),
});

export type AeoVisibility = z.infer<typeof aeoVisibilitySchema>;

// ---------------------------------------------------------------------------
// Enrichment blocks (§7) — each optional so a failed step degrades to an
// omitted report section, same posture as v1 partial failures.
// ---------------------------------------------------------------------------

export const aeoSourceMixSchema = z.object({
  sections: z.array(
    z.object({
      key: z.string(),
      perSurface: z.array(
        z.object({ surface: aeoSurfaceSchema, counts: sourceMixCountsSchema }),
      ),
      total: sourceMixCountsSchema,
    }),
  ),
});

export type AeoSourceMix = z.infer<typeof aeoSourceMixSchema>;

export const aeoPerceptionSchema = z.object({
  sections: z.array(
    z.object({
      key: z.string(),
      // Tallies over captured answers that mention the brand.
      sentiment: z.object({
        positive: z.number(),
        neutral: z.number(),
        negative: z.number(),
      }),
      // Narrative phrases AI attaches to the brand ("open-source",
      // "complex to set up"), with where they were said.
      narratives: z.array(
        z.object({
          phrase: z.string(),
          promptIdx: z.number(),
          surface: aeoSurfaceSchema,
        }),
      ),
      // Suspected factual errors vs the config's product brief — flagged for
      // human verification, never auto-published as fact (§7.2).
      flaggedClaims: z.array(
        z.object({
          claim: z.string(),
          reason: z.string(),
          promptIdx: z.number(),
          surface: aeoSurfaceSchema,
        }),
      ),
    }),
  ),
});

export type AeoPerception = z.infer<typeof aeoPerceptionSchema>;

export const aiBotKinds = ['training', 'search', 'user_fetch'] as const;

export const aeoTechnicalChecksSchema = z.object({
  crawlerAccess: z
    .object({
      robotsUrl: z.string(),
      fetchedAt: z.string(),
      robotsFetchError: z.string().nullable(),
      bots: z.array(
        z.object({
          bot: z.string(),
          kind: z.enum(aiBotKinds),
          // Null when robots.txt could not be fetched or parsed.
          robotsAllowed: z.boolean().nullable(),
          // Live GET with the bot's UA — search/user-fetch bots only; catches
          // WAF-level blocks robots.txt doesn't show. Null when not probed.
          liveStatus: z.number().nullable(),
          liveBlocked: z.boolean().nullable(),
          // What the live probe can honestly say. A request presenting as a
          // bot from the audit's own address is an impersonation to a site
          // that verifies bots by IP, so a 403 the site does not also give
          // a plain browser is `refused_as_bot`, never proof the real bot is
          // blocked; a 403 to the browser too says nothing about bots.
          // Absent on snapshots written before the control request existed.
          liveVerdict: z
            .enum(['ok', 'refused_as_bot', 'inconclusive'])
            .optional(),
        }),
      ),
      // The same page fetched with an ordinary browser agent from the same
      // address, right after the bot probes: the control the verdicts rest on.
      controlStatus: z.number().nullable().optional(),
    })
    .nullable(),
  renderability: z
    .array(
      z.object({
        url: z.string(),
        staticTextChars: z.number(),
        renderedTextChars: z.number(),
        // Fraction of rendered text missing from the no-JS fetch.
        missingRatio: z.number(),
        flagged: z.boolean(),
        error: z.string().nullable(),
      }),
    )
    .nullable(),
  llmsTxt: z
    .object({ llmsTxt: z.boolean(), llmsFullTxt: z.boolean() })
    .nullable(),
  agentReadiness: z
    .object({ mcpServer: z.boolean(), llmDocs: z.boolean() })
    .nullable(),
});

export type AeoTechnicalChecks = z.infer<typeof aeoTechnicalChecksSchema>;

export const aeoOutreachTargetsSchema = z.array(
  z.object({
    domain: z.string(),
    citations: z.number(),
    // Prompts this domain wins while the client is absent — resolved to text
    // at render via sectionKey + promptIdx.
    prompts: z.array(
      z.object({ sectionKey: z.string(), promptIdx: z.number() }),
    ),
    sampleUrls: z.array(z.string()),
  }),
);

export type AeoOutreachTargets = z.infer<typeof aeoOutreachTargetsSchema>;

// ---------------------------------------------------------------------------
// Snapshot v2
// ---------------------------------------------------------------------------

export const aeoSnapshotSchema = z.object({
  version: z.literal(aeoSnapshotVersion),
  reportKey: z.string(),
  brand: brandSchema,
  competitors: z.array(brandSchema),
  // Array, not fixed keys: a section that failed entirely is omitted while
  // the others still render.
  sections: z
    .array(z.object({ key: z.string(), visibility: aeoVisibilitySchema }))
    .min(1),
  sourceMix: aeoSourceMixSchema.optional(),
  perception: aeoPerceptionSchema.optional(),
  technicalChecks: aeoTechnicalChecksSchema.optional(),
  outreachTargets: aeoOutreachTargetsSchema.optional(),
  meta: z.object({
    // Review is additive. Exhausting its rounds records remaining work;
    // it never prevents delivery of the measured report.
    quality: z
      .object({
        needsImprovement: z.boolean(),
        reviewRounds: z.number().int().min(0).max(maxReviewRounds),
        issues: z.array(
          z.object({
            stage: z.string(),
            code: z.string(),
            message: z.string(),
            file: z.string().nullable().optional(),
            evidence: z.string().optional(),
          }),
        ),
      })
      .optional(),
    generatedAt: z.string(),
    promptCount: z.number(),
    // Successful probes across all sections.
    probeCount: z.number(),
    // Present when the run reused checkpointed probes (resume / --redo):
    // the snapshot then mixes capture ages, and generatedAt alone would
    // overstate freshness. Absent = every probe was captured by this run.
    reusedProbes: z
      .object({
        count: z.number(),
        oldestCapturedAt: z.string().nullable(),
      })
      .optional(),
    partialFailures: z.array(z.object({ step: z.string(), error: z.string() })),
    // The run's surface scope (correctness spec §3.6): with the pre-flight
    // CLI check, `agentClis.<cli>: null` can only mean "not in scope", and
    // this field says so explicitly. Optional: older snapshots lack it.
    surfaces: z.array(aeoSurfaceSchema).optional(),
    // Which agent CLIs answered, for the methodology note. Null = not run.
    agentClis: z
      .object({
        claudeCode: z.string().nullable(),
        codex: z.string().nullable(),
        // Optional: snapshots committed before the cursor surface existed
        // lack this key and must keep parsing.
        cursor: z.string().nullable().optional(),
      })
      .optional(),
    // Answer-analyzer version that produced the matrix (correctness spec
    // §3.7); a bump invalidates every cached analysis.
    analyzerVersion: z.number().int().optional(),
    // Domain-classifier version behind the source mix and outreach targets
    // (§7.1 amendment, 2026-09-04). Absent = static rules only (baselines
    // committed before the amendment).
    domainClassifierVersion: z.number().int().optional(),
    competitorClassifierVersion: z.number().int().optional(),
    // One-off data migrations applied to this committed file (correctness
    // spec §3.8), so a rewritten value is visible in the file itself.
    migrations: z
      .array(z.object({ id: z.string(), appliedAt: z.string() }))
      .optional(),
    // The run that produced the snapshot (hardening spec §4.2); every unit
    // record, analysis entry and log event of the run carries the same id.
    // Optional: snapshots committed before run identity existed lack it.
    runId: z.string().optional(),
    derivedFromRunId: z.string().optional(),
    replayKind: z.enum(['grounding', 'analysis']).optional(),
    groundingPolicyVersion: z.number().int().positive().optional(),
    // The model ids behind the analyzer and perception passes (§2.11).
    models: z
      .object({ analyzer: z.string(), perception: z.string() })
      .optional(),
  }),
});

export type AeoSnapshot = z.infer<typeof aeoSnapshotSchema>;

// ---------------------------------------------------------------------------
// Evidence chunks (§6) — one file per prompt per section, lazy-loaded by the
// report page's evidence drawer.
// ---------------------------------------------------------------------------

export const aeoEvidenceChunkSchema = z.object({
  sectionKey: z.string(),
  promptIdx: z.number(),
  promptText: z.string(),
  runs: z.array(
    z.object({
      surface: aeoSurfaceSchema,
      runIndex: z.number(),
      responseText: z.string(),
      // Raw retrieval log and the cited-URL → call attribution derived from
      // it (retrieval-log spec §4, §6). Absent = not captured for this run.
      retrieval: retrievalLogSchema.optional(),
      citationAttribution: citationAttributionSchema.optional(),
    }),
  ),
});

export type AeoEvidenceChunk = z.infer<typeof aeoEvidenceChunkSchema>;

export const evidenceChunkFileName = (
  sectionKey: string,
  promptIdx: number,
): string => {
  return `evidence/${sectionKey}-${promptIdx}.json`;
};

// ---------------------------------------------------------------------------
