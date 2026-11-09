import type {
  AeoAgentSurface,
  AeoAuditConfig,
  AeoPerception,
  AeoSnapshot,
  AeoSurface,
  AeoVisibility,
  RunRequest,
} from './schema';
import {
  aeoSnapshotVersion,
  allSurfaces,
  chatSurfaces,
  aeoSnapshotSchema,
  isAgentSurface,
} from './schema';
import { createLog } from './lib/log';
import type { AgentCliVersions } from './probes/agent-clis';
import type { ProbeLimiter } from './probes/limits';
import { resolveDataForSeoLocale } from './probes/dataforseo-locale';
import type { PartialFailure } from './probes/web-tool-guard';
import type { SectionRunResult } from './pipeline';
import {
  perceptionModel,
  perceptionVersion,
  legacyPerceptionVersion,
  extractPerceptionForSection,
  perceptionExtractionSchema,
  type PerceptionExtraction,
} from './analysis/sentiment';
import type { SourceClassifierConfig } from './analysis/source-classifier';
import { deriveOutreachTargets } from './analysis/outreach';
import { buildSourceMix } from './analysis/source-mix';
import { competitorClassifierVersion } from './analysis/competitor-classifier';
import {
  domainClassifierVersion,
  learnDomainLabels,
  type DomainLabelsFile,
  type LearnDomainLabelsResult,
} from './analysis/domain-classifier';
import { plannedProbeUnitsForSection, type ProbeUnit } from './lib/checkpoint';
import { perceptionKey } from './lib/analysis-checkpoint';
import type { CheckPhaseResult } from './checks/run-checks';
import type { AnalysisStore } from './stores/ports';
import type { InternalModelContext } from './models/context';
import { internalModelRoleDigest } from './models/profiles';

const log = createLog('AeoRunner');

// ============================================================================
// The deterministic half of a run: planning the probe units a request
// covers, and, once the Codex workflow has judged the answers, the source
// mix, the perception pass and the validated snapshot the report publishes
// (specs/aeo-codex-workflow-spec.md §5). No argv, no process.exit, no
// node:fs, no process.env in here.
// ============================================================================

/** A request the runner cannot act on (unknown section, plan over the cap). */
export class RunRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunRequestError';
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type RunPlan = {
  sections: AeoAuditConfig['sections'];
  surfaces: readonly AeoSurface[];
  chatSurfaces: AeoSurface[];
  agentSurfaces: AeoAgentSurface[];
  // Every probe unit the scope plans, across sections — the resume scope
  // the probe store is matched against and the scoring denominator.
  units: ProbeUnit[];
  probesBySurface: Map<AeoSurface, number>;
  promptCount: number;
  agentPromptCount: number;
  agentRunsPerPrompt: number;
  chatProbes: number;
  agentProbes: number;
};

export const resolveSections = (
  config: AeoAuditConfig,
  filter: readonly string[] | undefined,
): AeoAuditConfig['sections'] => {
  if (!filter) {
    return config.sections;
  }

  const sections = config.sections.filter((s) => filter.includes(s.key));

  if (sections.length === 0) {
    throw new RunRequestError(
      `No sections match ${filter.join(',')}. Available: ${config.sections
        .map((s) => s.key)
        .join(', ')}.`,
    );
  }

  return sections;
};

/**
 * The probe plan a run will execute, derived from the planned-units list —
 * the same source the store is matched against — so plan display, cost
 * estimate and resume scope can never disagree. A plan above the request's
 * cost cap is refused before any probe is sent (§4.2).
 */
export const planRun = (
  config: AeoAuditConfig,
  request: RunRequest,
): RunPlan => {
  const sections = resolveSections(config, request.sections);
  // The request's surfaces are the operator's override (a narrowed
  // re-probe); otherwise the config decides whether the coding agents are
  // measured (specs/aeo-surface-selection-spec.md §3.2).
  const surfaces: readonly AeoSurface[] =
    request.surfaces ??
    (config.surfaces.codingAgents === 'skip' ? chatSurfaces : allSurfaces);

  const units = sections.flatMap((section) =>
    plannedProbeUnitsForSection({
      sectionKey: section.key,
      prompts: section.prompts,
      surfaces,
      agentProbes: config.agentProbes,
      chatProbes: config.chatProbes,
    }),
  );

  // Google AI Overviews are placed in a market by DataForSEO's location
  // and language codes. A market the table cannot place is refused here,
  // before anything is reserved, never measured as the United States.
  if (
    surfaces.includes('google_ai_overview') &&
    !resolveDataForSeoLocale(config.geography, config.language)
  ) {
    throw new RunRequestError(
      `No search market for geography ${JSON.stringify(config.geography)} and language ${JSON.stringify(config.language)}: AI Overviews cannot be placed there. Please fix the config's geography and language (supported codes include us and en), or leave google_ai_overview out of the run.`,
    );
  }

  if (units.length > request.maxPlannedUnits) {
    throw new RunRequestError(
      `Plan of ${units.length} probe units exceeds the cap of ${request.maxPlannedUnits} (maxPlannedUnits); narrow the run or raise the cap deliberately.`,
    );
  }

  const probesBySurface = new Map<AeoSurface, number>();
  const agentPromptKeys = new Set<string>();
  let chatProbes = 0;
  let agentProbes = 0;

  for (const unit of units) {
    probesBySurface.set(
      unit.surface,
      (probesBySurface.get(unit.surface) ?? 0) + 1,
    );

    if (isAgentSurface(unit.surface)) {
      agentProbes += 1;
      agentPromptKeys.add(`${unit.sectionKey}|${unit.promptId}`);
    } else {
      chatProbes += 1;
    }
  }

  const promptCount = sections.reduce((sum, s) => sum + s.prompts.length, 0);

  return {
    sections,
    surfaces,
    chatSurfaces: surfaces.filter((s) => !isAgentSurface(s)),
    agentSurfaces: surfaces.filter(isAgentSurface),
    units,
    probesBySurface,
    promptCount,
    agentPromptCount: agentPromptKeys.size,
    agentRunsPerPrompt: config.agentProbes.runsPerPrompt,
    chatProbes,
    agentProbes,
  };
};

/** How much of a plan the probe bank already covered when the run began. */
export type PlanCoverage = {
  count: number;
  total: number;
  oldestCapturedAt: string | null;
};

// ---------------------------------------------------------------------------
// Enrich: learned domain labels, then the source mix and outreach
// targets derived with them. Failures are recorded, never blocking.
// ---------------------------------------------------------------------------

export type EnrichedReport = {
  labels: LearnDomainLabelsResult;
  sourceMix: NonNullable<AeoSnapshot['sourceMix']>;
  outreachTargets: NonNullable<AeoSnapshot['outreachTargets']>;
};

/** Qualified competitor domains, then a model pass over remaining cited hosts,
 * cached in the report's labels file. A failed batch degrades those hosts to
 * earned and lands in partialFailures under `domain_labels:` — deliberately
 * NOT a blocking prefix. */
export const enrichSourceMix = async (
  config: AeoAuditConfig,
  finishedSections: Array<{ key: string; visibility: AeoVisibility }>,
  ctx: {
    previousLabels: DomainLabelsFile | null;
    logContext: Record<string, unknown>;
    internalModels?: InternalModelContext;
    signal?: AbortSignal;
  },
): Promise<EnrichedReport> => {
  const staticClassifierConfig: SourceClassifierConfig = {
    brandDomain: config.brand.domain,
    competitorDomains: config.competitors.map((c) => c.domain),
    overrides: config.sourceOverrides,
  };

  log.info('Learning domain labels for the source mix', ctx.logContext);
  const labels = await learnDomainLabels({
    sections: finishedSections,
    staticConfig: staticClassifierConfig,
    context: {
      brandName: config.brand.name,
      brandDomain: config.brand.domain,
      productBrief: config.productBrief,
      promptTexts: finishedSections.flatMap((s) =>
        s.visibility.prompts.map((p) => p.text),
      ),
    },
    previous: ctx.previousLabels,
    logContext: ctx.logContext,
    internalModels: ctx.internalModels,
    signal: ctx.signal,
  });

  const classifierConfig: SourceClassifierConfig = {
    ...staticClassifierConfig,
    learned: labels.learned,
  };

  return {
    labels,
    sourceMix: buildSourceMix(finishedSections, classifierConfig),
    outreachTargets: deriveOutreachTargets(finishedSections, classifierConfig),
  };
};

// ---------------------------------------------------------------------------
// Assemble: the validated snapshot from everything the phases
// produced. Pure: the same inputs give the same snapshot.
// ---------------------------------------------------------------------------

export const assembleSnapshot = (args: {
  config: AeoAuditConfig;
  request: RunRequest;
  plan: RunPlan;
  completedSections: Array<{ key: string; result: SectionRunResult }>;
  enriched: EnrichedReport;
  perception: AeoPerception | undefined;
  checks: CheckPhaseResult['checks'] | undefined;
  agentCliVersions: AgentCliVersions;
  resumed: PlanCoverage;
  promptCount: number;
  probeCount: number;
  partialFailures: PartialFailure[];
  generatedAt: string;
  /** What judged the answers: the Codex analyze stage's version and model. */
  analyzer: { version: number; model: string };
}): AeoSnapshot => {
  const { config, request, plan, enriched, resumed } = args;

  return aeoSnapshotSchema.parse({
    version: aeoSnapshotVersion,
    reportKey: config.reportKey,
    brand: config.brand,
    competitors: config.competitors,
    sections: args.completedSections.map(({ key, result }) => ({
      key,
      visibility: result.visibility,
    })),
    sourceMix: enriched.sourceMix,
    ...(args.perception ? { perception: args.perception } : {}),
    technicalChecks: args.checks,
    outreachTargets: enriched.outreachTargets,
    meta: {
      generatedAt: args.generatedAt,
      promptCount: args.promptCount,
      probeCount: args.probeCount,
      // Honesty on resume: a snapshot mixing stored answers with fresh ones
      // must say so — generatedAt alone would overstate freshness.
      ...(resumed.count > 0
        ? {
            reusedProbes: {
              count: resumed.count,
              oldestCapturedAt: resumed.oldestCapturedAt,
            },
          }
        : {}),
      partialFailures: args.partialFailures,
      surfaces: [...plan.surfaces],
      agentClis: args.agentCliVersions,
      analyzerVersion: args.analyzer.version,
      domainClassifierVersion,
      ...(request.modelProfile?.roles.competitorClassifier
        ? { competitorClassifierVersion }
        : {}),
      runId: request.runId,
      models: {
        analyzer: args.analyzer.model,
        perception:
          request.modelProfile?.roles.perception.model ?? perceptionModel,
      },
    },
  } satisfies AeoSnapshot);
};

// ---------------------------------------------------------------------------
// Perception pass; a failed batch degrades to skipped
// answers, but every loss lands in partialFailures (never silent). Cached
// per section in the analysis store (correctness spec §3.7) so an unchanged
// answer set replays without the model.
// ---------------------------------------------------------------------------

/** One section's perception pass, cached per exact answer set. A targeted
 * repair bypasses the cached extraction and replaces it on success. */
const runSectionPerception = async (
  {
    key,
    result,
  }: {
    key: string;
    result: Pick<SectionRunResult, 'visibility' | 'brandMentionAnswers'>;
  },
  ctx: {
    config: AeoAuditConfig;
    analysisStore: AnalysisStore | null;
    runId: string;
    limiter?: ProbeLimiter;
    signal?: AbortSignal;
    internalModels?: InternalModelContext;
    bypassCache?: boolean;
  },
) => {
  const { config, internalModels, runId } = ctx;
  const cacheKey = perceptionKey({
    sectionKey: key,
    identity: { brand: config.brand, competitors: config.competitors },
    productBrief: config.productBrief,
    answers: result.brandMentionAnswers.map((a) => ({
      surface: a.surface,
      runIndex: a.runIndex,
      promptIdx: a.promptIdx,
      text: a.responseText,
    })),
    perceptionVersion: internalModels
      ? perceptionVersion
      : legacyPerceptionVersion,
    modelProfileDigest: internalModels
      ? internalModelRoleDigest(internalModels.profile.roles.perception)
      : undefined,
  });

  const cached = ctx.bypassCache
    ? null
    : ((await ctx.analysisStore?.get(cacheKey, perceptionExtractionSchema)) ??
      null);

  const extract = () => {
    return extractPerceptionForSection({
      sectionKey: key,
      brandName: config.brand.name,
      productBrief: config.productBrief,
      visibility: result.visibility,
      answers: result.brandMentionAnswers,
      cachedExtraction: cached,
      logContext: { reportKey: config.reportKey, runId },
      signal: ctx.signal,
      internalModels,
    });
  };

  const extracted = ctx.limiter
    ? await ctx.limiter.run('analyzer', extract)
    : await extract();

  if (!cached && extracted.failures.length === 0) {
    await ctx.analysisStore?.put(
      cacheKey,
      {
        narratives: extracted.section.narratives,
        flaggedClaims: extracted.section.flaggedClaims,
      } satisfies PerceptionExtraction,
      {
        runId,
        version: internalModels ? perceptionVersion : legacyPerceptionVersion,
        modelId:
          internalModels?.profile.roles.perception.model ?? perceptionModel,
      },
    );
  }

  return extracted;
};

export type PerceptionPassOptions = {
  analysisStore: AnalysisStore;
  runId: string;
  limiter: ProbeLimiter;
  signal?: AbortSignal;
  internalModels?: InternalModelContext;
};

export const runPerceptionPass = async (
  config: AeoAuditConfig,
  completedSections: Array<{ key: string; result: SectionRunResult }>,
  {
    analysisStore,
    runId,
    limiter,
    signal,
    internalModels,
  }: PerceptionPassOptions,
): Promise<{
  perception: AeoPerception | undefined;
  failures: PartialFailure[];
}> => {
  const failures: PartialFailure[] = [];

  try {
    const perceptionResults = await Promise.all(
      completedSections.map((section) =>
        runSectionPerception(section, {
          config,
          analysisStore,
          runId,
          limiter,
          signal,
          internalModels,
        }),
      ),
    );

    // A validation failure blocks like an analysis failure; a transport
    // failure after retries records under the non-blocking `perception:`
    // prefix (§2.6).
    for (const { section, failures: sectionFailures } of perceptionResults) {
      for (const failure of sectionFailures) {
        failures.push({
          step: failure.blocking
            ? `analysis:perception:${section.key}`
            : `perception:${section.key}`,
          error: failure.message,
        });
      }
    }

    return {
      perception: { sections: perceptionResults.map((r) => r.section) },
      failures,
    };
  } catch (error) {
    failures.push({ step: 'analysis:perception', error: String(error) });

    return { perception: undefined, failures };
  }
};
