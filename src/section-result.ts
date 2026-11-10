import type {
  AeoAgentSurface,
  AeoChatSurface,
  AeoEvidenceChunk,
  AeoMatrixRow,
  AeoVisibility,
} from './schema';
import {
  agentProbedPrompts,
  agentSurfaces,
  allSurfaces,
  chatSurfaces,
  evidenceChunkFileName,
  isAgentSurface,
} from './schema';
import {
  computeAISearchSummary,
  type AnalyzedProbeForScoring,
  type ScoringCounts,
} from './analysis/scoring';
import { rateEvidence, type RateEvidence } from './analysis/rate-evidence';
import type { CalculationVersion } from './bundle/contracts';
import {
  attributeCitations,
  summarizeRetrievalCalls,
} from './analysis/retrieval';
import type { BrandMentionAnswer } from './analysis/sentiment';
import type {
  AnalyzedRun,
  PromptAnalysisResult,
  SectionCaptureSummary,
  SectionRunArgs,
  SectionRunResult,
} from './pipeline';

// ============================================================================
// The arithmetic half of the section pipeline (see pipeline.ts): the judged
// runs and the capture summary in, scoring, the matrix, visibility and
// evidence chunks out. It imports no probe or provider code, so the offline
// bundle verifier recomputes a report with exactly this function
// (specs/aeo-open-source-cli-spec.md §10) without loading a capture path.
// ============================================================================

/** The evidence beside a share of voice and a citation rate (calculation
 * version 2); a rate with nothing planned gets none. */
const evidenceOf = (
  counts: ScoringCounts,
): { shareOfVoice: RateEvidence | null; citationRate: RateEvidence | null } => {
  return {
    shareOfVoice: rateEvidence(
      counts.mentioned,
      counts.captured,
      counts.planned,
    ),
    citationRate: rateEvidence(counts.cited, counts.captured, counts.planned),
  };
};

/** Pure assembly of a section from its capture and extractions: scoring,
 * evidence split, matrix and visibility. The same inputs and calculation
 * version give the same result; version 1 is the arithmetic before rates
 * carried their evidence, byte for byte. */
export const assembleSectionResult = (
  args: Pick<
    SectionRunArgs,
    | 'sectionKey'
    | 'brand'
    | 'competitors'
    | 'prompts'
    | 'surfaces'
    | 'agentProbes'
    | 'chatProbes'
  > & { calculationVersion: CalculationVersion },
  capture: SectionCaptureSummary,
  analyses: readonly PromptAnalysisResult[],
): SectionRunResult => {
  const withEvidence = args.calculationVersion >= 2;
  const selectedChatSurfaces = args.surfaces.filter(
    (s): s is AeoChatSurface => !isAgentSurface(s),
  );

  const selectedAgentSurfaces = args.surfaces.filter(
    (s): s is AeoAgentSurface => isAgentSurface(s),
  );

  const depth = { agentProbes: args.agentProbes, chatProbes: args.chatProbes };
  const agentPrompts = agentProbedPrompts(args.prompts, args.agentProbes);

  const probeCount = capture.probeCount;
  const analysisFailures: SectionRunResult['analysisFailures'] =
    analyses.flatMap((analysis) =>
      analysis.error === null
        ? []
        : [{ promptId: analysis.promptId, error: analysis.error }],
    );

  // Canonical order (§4.9): prompt, then surface in allSurfaces order, then
  // run index — independent of store state and worker completion order.
  const allResults = analyses
    .flatMap((analysis) => analysis.runs)
    .sort(compareRuns);

  const failedPromptIds = new Set(analysisFailures.map((f) => f.promptId));

  const toScoringInput = (r: AnalyzedRun): AnalyzedProbeForScoring => {
    return {
      model: r.surface,
      promptId: r.promptId,
      clientMentioned: r.clientMentioned,
      clientCited: r.clientCited,
      competitorMentions: r.competitorMentions,
      allMentionedBrands: r.allMentionedBrands,
    };
  };

  // Scoring denominators (§3.3, hardening spec §2.5): a prompt whose
  // ANALYSIS failed leaves the plan (it would count as "absent" when it was
  // never judged); a prompt with no captures stays in it (the shortfall is
  // real and lowers share of voice).
  const promptsForScoring = args.prompts
    .filter((p) => !failedPromptIds.has(p.id))
    .map((p) => ({ id: p.id, category: p.category }));

  const agentPromptsForScoring = agentPrompts
    .filter((p) => !failedPromptIds.has(p.id))
    .map((p) => ({ id: p.id, category: p.category }));

  const competitorDomains = args.competitors.map((c) => c.domain);

  // Scoring scope (spec §5): headline scorecards over the chat surfaces only,
  // comparable across baselines; the agent surfaces get their own pair. A
  // scope that didn't run — or has no prompt left to score — yields null:
  // an unmeasured scope must never look like a measured 0%.
  const chatSummary =
    selectedChatSurfaces.length > 0 && promptsForScoring.length > 0
      ? computeAISearchSummary({
          clientDomain: args.brand.domain,
          competitorDomains,
          prompts: promptsForScoring,
          results: allResults
            .filter((r) => !isAgentSurface(r.surface))
            .map(toScoringInput),
          surfaces: selectedChatSurfaces,
          depth,
        })
      : null;

  const agentResults = allResults.filter((r) => isAgentSurface(r.surface));
  const agentSummary =
    selectedAgentSurfaces.length > 0 && agentPromptsForScoring.length > 0
      ? computeAISearchSummary({
          clientDomain: args.brand.domain,
          competitorDomains,
          // Denominators reflect the configured agent plan: only the probed
          // prompt subset, at the configured run count.
          prompts: agentPromptsForScoring,
          results: agentResults.map(toScoringInput),
          surfaces: selectedAgentSurfaces,
          depth,
        })
      : null;

  // Translate from scorecard percentages (0-100) to the visibility shape
  // (0-1 rates). byModel spans every surface that ran.
  const byModel: AeoVisibility['summary']['byModel'] = {};

  for (const summary of [chatSummary, agentSummary]) {
    if (!summary) {
      continue;
    }

    for (const [name, vals] of Object.entries(summary.byModel)) {
      const counts = summary.byModelCounts[name];
      const evidence = withEvidence && counts ? evidenceOf(counts) : null;

      byModel[name] = {
        shareOfVoice: vals.sov / 100,
        citationRate: vals.citation / 100,
        ...(evidence?.shareOfVoice && {
          shareOfVoiceEvidence: evidence.shareOfVoice,
        }),
        ...(evidence?.citationRate && {
          citationRateEvidence: evidence.citationRate,
        }),
      };
    }
  }

  // Competitor scores come from whichever scope was measured — chat when it
  // ran (the v1-comparable set), otherwise the agent runs. They split the
  // captured answers, so version 2 adds their counts, not an interval.
  const competitorSummary = chatSummary ?? agentSummary;
  const byCompetitor = (competitorSummary?.competitorScores ?? []).map(
    (c, index) => {
      const counts = withEvidence
        ? competitorSummary?.competitorCounts[index]
        : undefined;

      return {
        domain: c.domain,
        shareOfVoice: c.sov / 100,
        citationRate: c.citation / 100,
        ...(counts && {
          mentionedAnswers: counts.mentioned,
          citedAnswers: counts.cited,
          capturedAnswers: counts.captured,
        }),
      };
    },
  );
  const chatEvidence =
    withEvidence && chatSummary ? evidenceOf(chatSummary.counts) : null;
  const agentEvidence =
    withEvidence && agentSummary ? evidenceOf(agentSummary.counts) : null;

  const topCompetitorDomain =
    [...byCompetitor].sort((a, b) => b.shareOfVoice - a.shareOfVoice)[0]
      ?.domain ?? null;

  // Evidence split (§6): one chunk file per prompt, holding every captured
  // run's full answer text; matrix rows reference the chunk by path. Only
  // analyzed prompts get a chunk — an excluded prompt has no rows to back.
  const evidenceChunks: AeoEvidenceChunk[] = [];
  const chunkByPromptIdx = new Map<number, AeoEvidenceChunk>();

  for (const run of allResults) {
    if (!run.responseText) {
      continue;
    }

    let chunk = chunkByPromptIdx.get(run.promptIdx);

    if (!chunk) {
      chunk = {
        sectionKey: args.sectionKey,
        promptIdx: run.promptIdx,
        promptText: args.prompts[run.promptIdx]?.text ?? '',
        runs: [],
      };

      chunkByPromptIdx.set(run.promptIdx, chunk);
      evidenceChunks.push(chunk);
    }

    chunk.runs.push({
      surface: run.surface,
      runIndex: run.runIndex,
      responseText: run.responseText,
      // Raw retrieval log + cited-URL → call attribution (§6), chunk-only.
      ...(run.retrieval
        ? {
            retrieval: run.retrieval,
            citationAttribution: attributeCitations(
              run.citedUrls,
              run.retrieval,
            ),
          }
        : {}),
    });
  }

  const matrix: AeoMatrixRow[] = allResults.map((r) => ({
    promptIdx: r.promptIdx,
    surface: r.surface,
    prospectMentioned: r.clientMentioned,
    prospectPosition: r.clientPosition,
    contextSnippet: r.contextSnippet,
    runIndex: r.runIndex,
    citedUrls: r.citedUrls,
    mentionedBrands: r.allMentionedBrands,
    competitors: r.competitorMentions.map((cm) => ({
      domain: cm.domain,
      mentioned: cm.mentioned,
    })),
    sentiment: r.clientSentiment,
    ...(r.usedWebSearch !== undefined
      ? { usedWebSearch: r.usedWebSearch, agentCliVersion: r.agentCliVersion }
      : {}),
    // Compact per-call presence summary for the aggregate views (§6); the
    // result URLs themselves stay in the chunk.
    ...(r.retrieval
      ? {
          retrievalExposure: r.retrieval.exposure,
          retrievalCalls: summarizeRetrievalCalls(
            r.retrieval,
            args.brand,
            args.competitors,
          ),
        }
      : {}),
    ...(r.noOverview ? { noOverview: true as const } : {}),
    evidenceFile: r.responseText
      ? evidenceChunkFileName(args.sectionKey, r.promptIdx)
      : null,
  }));

  const visibility: AeoVisibility = {
    prompts: args.prompts.map((p) => ({ text: p.text, category: p.category })),
    surfaces: [
      ...chatSurfaces.filter((s) => selectedChatSurfaces.includes(s)),
      ...agentSurfaces.filter((s) => selectedAgentSurfaces.includes(s)),
    ],
    matrix,
    summary: {
      prospectShareOfVoice: chatSummary
        ? chatSummary.probeShareOfVoice / 100
        : null,
      prospectCitationRate: chatSummary
        ? chatSummary.probeCitationRate / 100
        : null,
      agentShareOfVoice: agentSummary
        ? agentSummary.probeShareOfVoice / 100
        : null,
      agentCitationRate: agentSummary
        ? agentSummary.probeCitationRate / 100
        : null,
      ...(chatEvidence?.shareOfVoice && {
        prospectShareOfVoiceEvidence: chatEvidence.shareOfVoice,
      }),
      ...(chatEvidence?.citationRate && {
        prospectCitationRateEvidence: chatEvidence.citationRate,
      }),
      ...(agentEvidence?.shareOfVoice && {
        agentShareOfVoiceEvidence: agentEvidence.shareOfVoice,
      }),
      ...(agentEvidence?.citationRate && {
        agentCitationRateEvidence: agentEvidence.citationRate,
      }),
      byModel,
      byCompetitor,
      topCompetitorDomain,
    },
  };

  const brandMentionAnswers: BrandMentionAnswer[] = allResults.flatMap((r) =>
    r.clientMentioned && r.responseText
      ? [
          {
            promptIdx: r.promptIdx,
            surface: r.surface,
            runIndex: r.runIndex,
            responseText: r.responseText,
          },
        ]
      : [],
  );

  return {
    visibility,
    evidenceChunks,
    probeCount,
    brandMentionAnswers,
    analysisFailures,
    rejectedWebToolSurfaces: capture.rejectedWebToolSurfaces,
    freshChatRetrieval: capture.freshChatRetrieval,
    freshAgentRetrieval: capture.freshAgentRetrieval,
    coverage: capture.coverage,
    lostPromptIds: capture.lostPromptIds,
    unitFailures: capture.unitFailures,
  };
};

const surfaceOrder = new Map<string, number>(
  allSurfaces.map((surface, index) => [surface, index]),
);

const compareRuns = (a: AnalyzedRun, b: AnalyzedRun): number => {
  return (
    a.promptIdx - b.promptIdx ||
    (surfaceOrder.get(a.surface) ?? 0) - (surfaceOrder.get(b.surface) ?? 0) ||
    a.runIndex - b.runIndex
  );
};
