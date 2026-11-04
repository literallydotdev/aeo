import { z } from 'zod';

// ============================================================================
// Criterion registry: the one list of rules the producing stages are
// instructed from and the review pass judges by (specs/aeo-codex-workflow-
// spec.md §4). Severity is pinned here; a reviewer's suggested severity is
// never an acceptance condition.
// ============================================================================

/** Which review reads a criterion: the evidence review over the analysis
 * and qualification rows, the copy premise check, or the final pass. */
export type ReviewRole = 'evidence' | 'copy_premise' | 'final';

/** The producers a criterion guides. */
export type ProducerTarget =
  | 'aggregate'
  | 'analysis'
  | 'copy_block'
  | 'enrichment'
  | 'grounding'
  | 'perception';

export const criterionSeveritySchema = z.enum(['blocking', 'advisory']);
export type CriterionSeverity = z.infer<typeof criterionSeveritySchema>;

export type Criterion = {
  id: string;
  severity: CriterionSeverity;
  roles: readonly ReviewRole[];
  /** Which producing stages a finding under this criterion may target. */
  targets: readonly ProducerTarget[];
  description: string;
  /** What the producing stage must do to satisfy this criterion, in the
   * producer's own terms. The writer's and the analyzer's prompts are built
   * from this text, so a stage cannot be instructed to do what its reviewer
   * refuses (measured 2026-09-12: the writer was told to explain "the buying
   * decision" and every draft was rejected for it). */
  guidance: string;
};

const registry: readonly Criterion[] = [
  {
    id: 'false_product_attribution',
    severity: 'blocking',
    roles: ['evidence', 'final'],
    targets: ['analysis', 'aggregate'],
    description:
      'A parent-brand or unrelated mention was credited to the measured product.',
    guidance:
      'A mention counts only when the answer presents the measured product itself as an option, recommendation or subject. The client\'s name or alias appearing as a technology, runtime, language or parent brand behind another vendor\'s product (for example "Netlify offers Deno-based edge functions", "Hono runs on Deno", "built on Deno") is not a mention: report absent and credit no context snippet for it.',
  },
  {
    id: 'unjustified_competitor_inclusion',
    severity: 'blocking',
    roles: ['evidence', 'final'],
    targets: ['enrichment'],
    description:
      'A qualified competitor row is not a competitor in the section market.',
    guidance:
      'Qualify a named product as a competitor only when the answer presents it as a buyer\'s alternative for this section\'s question; a framework, runtime, publisher or platform named in passing is not one. An umbrella brand or cloud ("AWS", "Azure", "Google Cloud", "Cloudflare", "Netlify") is not itself an alternative: qualify the specific product the answer recommends ("AWS Lambda", "Google Cloud Run") and leave the umbrella as context. One entry per alternative: a short form ("Cloud Run", "Workers", "Lambda") is the same alternative as its full name and must not be qualified twice.',
  },
  {
    id: 'competitor_omission',
    severity: 'blocking',
    roles: ['evidence'],
    targets: ['enrichment'],
    description:
      'An observed configured alternative was excluded or left unknown without basis.',
    guidance:
      'A configured competitor the answer presents as an alternative must be qualified under its configured domain; do not leave it unknown or drop it because it appears under a product name. An alternative the answer recommends by name for this question ("Need native deps -> Cloud Run or Lambda") is presented as an alternative and must be qualified even when it is not configured.',
  },
  {
    id: 'unsupported_published_assertion',
    severity: 'blocking',
    roles: ['evidence', 'copy_premise', 'final'],
    targets: ['grounding', 'copy_block'],
    description:
      'A published assertion lacks retained supporting evidence or is contradicted.',
    guidance:
      'Every sentence must rest on a supplied fact, implications included. Do not state buyer behaviour (what buyers, developers or teams ask, want, trust or decide; a configured question is what this audit asked). Do not state positioning or competition (competes for, leads, trails, is the default, behind or ahead of anyone). Do not rank or compare ("most", "more than", "behind X and Y", "only", "just as often", "first") unless one fact states exactly that; two counts side by side are two counts. Do not describe what assistants said about the product without an observed_claim or assessment fact carrying that content. Do not infer unmeasured qualities (caveats, sentiment, hesitation, "the only citation") from counts. Name surfaces exactly as the scope facts do. Say "this audit", never "Literally.dev measured": the host inserts the publisher.',
  },
  {
    id: 'incorrect_visible_metric',
    severity: 'blocking',
    roles: ['final'],
    // The published value lives in the copy; the aggregate it should match
    // is deterministic, so a finding may target either.
    targets: ['copy_block', 'aggregate'],
    description:
      'A published value differs from the deterministic projection of its measurement.',
    guidance:
      'Report every count exactly as its measurement fact states it, with the same numerator, denominator and scope.',
  },
  {
    id: 'question_set_confusion',
    severity: 'blocking',
    roles: ['final'],
    targets: ['aggregate'],
    description:
      'The report conflates question sets or measurements in a comparison.',
    guidance:
      'Compare only measurements taken over the same questions, surfaces and repetitions, and say when scope changed.',
  },
  {
    id: 'misleading_coverage_language',
    severity: 'blocking',
    roles: ['copy_premise', 'final'],
    targets: ['copy_block'],
    description: 'Copy overstates measured coverage, surfaces or completeness.',
    guidance:
      'Describe coverage as the scope facts do: which surfaces were captured, how many answers, and nothing about surfaces, completeness or populations the facts do not cover.',
  },
  {
    id: 'ambiguous_source_classification',
    severity: 'blocking',
    roles: ['evidence'],
    targets: ['enrichment'],
    description: 'A cited source is classified under the wrong category.',
    guidance:
      "Classify a cited host by what it is in this market: owned only for the client's own domains, competitor only for configured or qualified alternatives, otherwise social, institutional or earned.",
  },
  {
    id: 'perception_misreading',
    severity: 'advisory',
    roles: ['evidence', 'final'],
    targets: ['perception'],
    description: 'A perception narrative misreads the retained answers.',
    guidance:
      'Quote narratives verbatim from the retained answers and read sentiment from what the answer says about the product, not about the runtime or another vendor.',
  },
  {
    id: 'style_preference',
    severity: 'advisory',
    roles: ['copy_premise', 'final'],
    targets: ['copy_block'],
    description: 'A stylistic suggestion with no factual consequence.',
    guidance:
      'Plain, short sentences; no links, HTML, dashes or banned phrases.',
  },
];

export const criterionRegistryVersion = 3;

const severityRank = (severity: Criterion['severity']): number => {
  return severity === 'blocking' ? 0 : 1;
};

export const criteriaForRole = (role: ReviewRole): Criterion[] => {
  return registry.filter((entry) => entry.roles.includes(role));
};

export const allCriteria = (): readonly Criterion[] => {
  return registry;
};

/**
 * producerGuidance returns the guidance a producing stage must follow,
 * blocking criteria first: the same registry the reviewers judge by, in the
 * producer's terms.
 */
export const producerGuidance = (target: ProducerTarget): string[] => {
  return [...registry]
    .filter((entry) => entry.targets.includes(target))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .map((entry) => `${entry.id} (${entry.severity}): ${entry.guidance}`);
};
