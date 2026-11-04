import { normalizeDomain } from '../report/core/normalize-domain';
import type { AeoSurface } from '../schema';
import { surfaceRunCounts, plannedRunsPerPrompt } from '../surfaces';

// ============================================================================
// Scorecard aggregation (ported from the console's intelligence/scoring.ts).
// v2 change (spec §5): the same math now runs twice per section — once over
// the chat surfaces (the headline, comparable with v1 baselines) and once
// over the agent surfaces (the agent scorecard pair). Callers pass the
// surface scope.
//
// Denominators (correctness spec §3.5): the headline rates AND the
// per-surface `byModel` rates divide by PLANNED runs (prompts × runs per
// surface), so a surface whose CLI failed half its probes shows a lower
// share of voice, never an inflated one. `byCategory` and
// `competitorScores` stay on CAPTURED runs: they are ratios within the
// captured set (how the captured answers split), not visibility claims
// against a plan. `prompts` must be the analyzed prompts only — an
// unanalyzed prompt is excluded upstream and must not count as "absent".
// ============================================================================

export type AnalyzedProbeForScoring = {
  model: string;
  promptId: string;
  clientMentioned: boolean;
  clientCited: boolean;
  competitorMentions: Array<{
    domain: string;
    mentioned: boolean;
    cited: boolean;
    position?: string;
  }>;
  allMentionedBrands: Array<{ name: string; domain: string | null }>;
};

export type PromptForScoring = {
  id: string;
  category: string;
};

export type ScoringSummary = {
  totalPrompts: number;
  probeShareOfVoice: number;
  probeCitationRate: number;
  byModel: Record<string, { sov: number; citation: number }>;
  byCategory: Record<string, { sov: number; citation: number }>;
  competitorScores: Array<{ domain: string; sov: number; citation: number }>;
};

export { normalizeDomain } from '../report/core/normalize-domain';

/**
 * computeAISearchSummary aggregates analyzed probe results into the scorecard
 * shape. Pure function — extracted verbatim from the console; behavior must not
 * regress. `surfaces` defines both the planned-run denominator (prompts × runs
 * across those surfaces) and the per-model breakdown scope; pass only results
 * captured on those surfaces.
 */
export const computeAISearchSummary = (args: {
  clientDomain: string;
  competitorDomains: string[];
  prompts: PromptForScoring[];
  results: AnalyzedProbeForScoring[];
  surfaces: readonly AeoSurface[];
  // Overrides the canonical per-surface run count (agent batches configured
  // below the default, spec §5 revised). Applies uniformly to every scoped
  // surface; omit for the canonical surfaceRunCounts denominators.
  runsPerSurface?: number;
}): ScoringSummary => {
  const { competitorDomains, prompts, results, surfaces } = args;

  // Probe planning: total probes attempted = prompts × (sum of runs across
  // the scoped surfaces). Failures lower share of voice instead of hiding.
  const totalRunsPerPrompt =
    args.runsPerSurface !== undefined
      ? surfaces.length * args.runsPerSurface
      : plannedRunsPerPrompt(surfaces);
  const totalPrompts = prompts.length * totalRunsPerPrompt;

  const mentioned = results.filter((r) => r.clientMentioned).length;
  const cited = results.filter((r) => r.clientCited).length;

  const probeShareOfVoice =
    totalPrompts > 0 ? (mentioned / totalPrompts) * 100 : 0;
  const probeCitationRate = totalPrompts > 0 ? (cited / totalPrompts) * 100 : 0;

  // By model — planned runs per surface, same rule as the headline.
  const byModel: Record<string, { sov: number; citation: number }> = {};

  for (const surface of surfaces) {
    const modelResults = results.filter((r) => r.model === surface);
    const runsPerPrompt = args.runsPerSurface ?? surfaceRunCounts[surface];
    const total = prompts.length * runsPerPrompt;

    byModel[surface] = {
      sov:
        total > 0
          ? (modelResults.filter((r) => r.clientMentioned).length / total) * 100
          : 0,
      citation:
        total > 0
          ? (modelResults.filter((r) => r.clientCited).length / total) * 100
          : 0,
    };
  }

  // By category.
  const categories = [...new Set(prompts.map((p) => p.category))];
  const byCategory: Record<string, { sov: number; citation: number }> = {};

  for (const cat of categories) {
    const catPromptIds = prompts
      .filter((p) => p.category === cat)
      .map((p) => p.id);
    const catResults = results.filter((r) => catPromptIds.includes(r.promptId));
    const total = catResults.length;

    byCategory[cat] = {
      sov:
        total > 0
          ? (catResults.filter((r) => r.clientMentioned).length / total) * 100
          : 0,
      citation:
        total > 0
          ? (catResults.filter((r) => r.clientCited).length / total) * 100
          : 0,
    };
  }

  // Competitor scores match on normalized domains.
  const competitorScores = competitorDomains.map((rawDomain) => {
    const domain = normalizeDomain(rawDomain);
    const total = results.length;
    const mentioned2 = results.filter((r) =>
      r.competitorMentions.some((cm) => {
        const cmNorm = normalizeDomain(cm.domain);

        return (cmNorm === domain || cm.domain === domain) && cm.mentioned;
      }),
    ).length;

    const cited2 = results.filter((r) =>
      r.competitorMentions.some((cm) => {
        const cmNorm = normalizeDomain(cm.domain);

        return (cmNorm === domain || cm.domain === domain) && cm.cited;
      }),
    ).length;

    return {
      domain,
      sov: total > 0 ? (mentioned2 / total) * 100 : 0,
      citation: total > 0 ? (cited2 / total) * 100 : 0,
    };
  });

  const summary = {
    totalPrompts,
    probeShareOfVoice,
    probeCitationRate,
    byModel,
    byCategory,
    competitorScores,
  };

  return summary;
};
