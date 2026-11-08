import type {
  AeoAgentSurface,
  AeoBrand,
  AeoChatSurface,
  AeoEvidenceChunk,
  AeoPrompt,
  AeoSurface,
  AeoVisibility,
  AgentProbeConfig,
  ChatProbeConfig,
  RetrievalLog,
} from './schema';
import { agentProbedPrompts, isAgentSurface } from './schema';
import { createLog } from './lib/log';
import { runProbesForPrompts, type ProbeResult } from './probes/probes';
import {
  runAgentProbesForPrompts,
  type AgentCliVersions,
  type AgentProbeResult,
  type AgentRuntime,
} from './probes/agent-clis';
import type { ProbeOutcome } from './probes/outcomes';
import type { ProbeFailureKind } from './probes/failure';
import type { ProbeLimiter } from './probes/limits';
import { withSection, type ProbeTrace } from './probes/probe-trace';
import { requestedModelOf } from './probes/attempt';
import type { ProbeDependencies, RunBindings } from './probes/bindings';
import { legacyProbeBindings } from './probes/legacy-bindings';
import {
  plannedProbeUnitsForSection,
  probeUnitKey,
  type ProbeUnit,
} from './lib/checkpoint';
import {
  UnitConflictError,
  type AnalysisStore,
  type CheckpointProbe,
  type ProbeStore,
} from './stores/ports';
import type { BrandMentionAnswer } from './analysis/sentiment';
import type { InternalModelContext } from './models/context';
export { assembleSectionResult } from './section-result';

const log = createLog('AeoPipeline');

// ============================================================================
// Section pipeline, in two halves the Codex workflow calls separately:
// `captureSectionProbes` runs the probes (API + agent CLIs) with store resume,
// and `assembleSectionResult` turns the capture plus the judged runs into
// scoring, AeoVisibility and evidence chunks (raw answer text goes to chunk
// files, never into the snapshot). Judging the answers happens in between, in
// the Codex analyze stage (src/codex-workflow/aggregate.ts lifts its output
// into `AnalyzedRun` rows); the in-process analyzer that used to sit here is
// gone.
//
// Integrity rules (correctness spec §3.2–§3.5, hardening spec §4.1, §4.9):
//  - every planned probe unit ends in exactly one recorded outcome; a unit
//    that exhausted its attempts is stored as a failed record and counted
//    against the surface's coverage, never dropped;
//  - a prompt whose analysis failed is EXCLUDED (grey "no data"), never
//    scored as absent; a prompt with no captures STAYS in the denominator;
//  - citation is deterministic: a URL in the answer text on the brand's (or
//    competitor's) domain;
//  - rows are canonically ordered (prompt, surface, run), so the snapshot is
//    a pure function of its inputs.
// ============================================================================

export type SurfaceCoverage = {
  surface: AeoSurface;
  planned: number;
  captured: number;
};

export type UnitFailureSummary = {
  promptId: string;
  surface: AeoSurface;
  runIndex: number;
  kind: ProbeFailureKind;
  attempts: number;
};

export type SectionRunResult = {
  visibility: AeoVisibility;
  evidenceChunks: AeoEvidenceChunk[];
  probeCount: number;
  // Full answer texts for brand-mentioning runs — input to the perception
  // pass (§7.2), which runs after the matrix exists.
  brandMentionAnswers: BrandMentionAnswer[];
  // Prompts excluded from the matrix because their analysis failed after
  // retries (→ partialFailures `analysis:search:<section>:<promptId>`).
  analysisFailures: Array<{ promptId: string; error: string }>;
  // Agent surfaces whose every probe attempt ended in a rejected web tool
  // call — a runner configuration problem, reported once per run.
  rejectedWebToolSurfaces: AeoAgentSurface[];
  // Chat probes CAPTURED BY THIS RUN with the size of their retrieval log
  // (null = no log stored) — input to the retrieval-capture guard
  // (retrieval-log spec §7). Resumed store rows are excluded: they never
  // carry a log and are not evidence of an extractor miss.
  freshChatRetrieval: Array<{
    surface: AeoSurface;
    retrievalCalls: number | null;
  }>;
  // Agent probes CAPTURED BY THIS RUN with their web-tool flag — input to
  // the parse guard (hardening spec §2.9).
  freshAgentRetrieval: Array<{
    surface: AeoSurface;
    usedWebSearch: boolean | null;
  }>;
  // Planned versus captured units per surface (§4.1): the coverage gate's
  // input. Captured counts store hits and fresh captures alike.
  coverage: SurfaceCoverage[];
  // Prompts with zero captures on any surface: they stay in the scoring
  // plan (share of voice drops) and are recorded as `probes:lost:…`.
  lostPromptIds: string[];
  // Units that exhausted their attempts in this run, for the summary.
  unitFailures: UnitFailureSummary[];
};

export type SectionRunArgs = {
  internalModels?: InternalModelContext;
  sectionKey: string;
  brand: AeoBrand;
  competitors: AeoBrand[];
  prompts: AeoPrompt[];
  geography: string;
  language: string;
  surfaces: readonly AeoSurface[];
  // Agent probe volume (spec §5 revised): runs per prompt per agent surface,
  // and how many of the section's prompts get agent probes. Always present —
  // the config schema fills the canonical default.
  agentProbes: AgentProbeConfig;
  // Chat probe volume; undefined = the canonical surfaceRunCounts.
  chatProbes: ChatProbeConfig | undefined;
  agentCliVersions: AgentCliVersions;
  // The run every fresh capture and analysis is stamped with (§4.2).
  runId: string;
  // Probe store (resume): planned units already captured are reused, only
  // the missing ones execute, and fresh captures and failures are recorded.
  // Null disables persistence (tests).
  probeStore: ProbeStore | null;
  // Analysis store (§3.7): validated analyzer output per prompt, keyed by
  // brand identity + probe set + analyzer version. Null disables it.
  analysisStore: AnalysisStore | null;
  // Per-provider pools (§4.5); unbounded when omitted.
  limiter?: ProbeLimiter;
  agentRuntime?: AgentRuntime;
  // The run journal: every probe attempt becomes an operation.
  trace?: ProbeTrace;
  signal?: AbortSignal;
  // What the probe adapters are created with: the gateway, credentials,
  // clients.
  probeDependencies: ProbeDependencies;
  logContext: Record<string, unknown>;
};

export type AnalyzedRun = {
  promptIdx: number;
  promptId: string;
  surface: AeoSurface;
  runIndex: number;
  clientMentioned: boolean;
  clientCited: boolean;
  clientPosition: 'primary' | 'secondary' | 'listed' | 'absent';
  clientSentiment: 'positive' | 'neutral' | 'negative';
  contextSnippet: string | null;
  responseText: string | null;
  citedUrls: string[];
  competitorMentions: Array<{
    domain: string;
    mentioned: boolean;
    cited: boolean;
  }>;
  allMentionedBrands: Array<{ name: string; domain: string | null }>;
  usedWebSearch?: boolean | null;
  agentCliVersion?: string;
  // Absent = not captured for this run (retrieval-log spec §4).
  retrieval?: RetrievalLog;
  // Google AI Overview: the SERP carried no AI Overview (§4.1).
  noOverview?: true;
};

export type Probe = ProbeResult | AgentProbeResult;

/** The capture half of a section: stored hits plus fresh probes, with the
 * coverage and failure accounting the runner reports. No analysis happens here,
 * so the harness can journal captures and extractions as separate units. */
export type SectionCapture = {
  probes: Probe[];
  coverage: SurfaceCoverage[];
  lostPromptIds: string[];
  unitFailures: UnitFailureSummary[];
  rejectedWebToolSurfaces: AeoAgentSurface[];
  freshChatRetrieval: SectionRunResult['freshChatRetrieval'];
  freshAgentRetrieval: SectionRunResult['freshAgentRetrieval'];
};

/** One prompt's extraction: every captured run analyzed, or the failure that
 * excludes the prompt from the matrix (never scored as absent). */
export type PromptAnalysisResult = {
  promptId: string;
  runs: AnalyzedRun[];
  cached: boolean;
  error: string | null;
};

/** Everything assembly needs from a capture except the probe objects
 * themselves, which the harness keeps in the probe store by unit key. */
export type SectionCaptureSummary = Omit<SectionCapture, 'probes'> & {
  probeCount: number;
};

// The model a capture asked for, by the binding that captured it: the bound
// model of a model API, else the one an agent's answer names, else none.
const capturedRequestedModel = (
  probe: CheckpointProbe,
  bindings: RunBindings,
): string | null => {
  return requestedModelOf(
    bindings[probe.modelName],
    'requestedModel' in probe ? probe.requestedModel : undefined,
  );
};

// The adapter a capture records (probe adapters spec §4.6): only one that
// is not the surface's legacy adapter, so a capture taken with the legacy
// adapter keeps the bytes, profile and collection digest older releases
// gave it. Absent means the legacy adapter.
const recordedAdapterOf = (
  surface: AeoSurface,
  bindings: RunBindings,
): { adapter?: string } => {
  const { adapter } = bindings[surface];

  return adapter === legacyProbeBindings[surface].adapter ? {} : { adapter };
};

const isAgentProbe = (probe: Probe): probe is AgentProbeResult => {
  return isAgentSurface(probe.modelName);
};

export const captureSectionProbes = async (
  args: SectionRunArgs,
): Promise<SectionCapture> => {
  const selectedChatSurfaces = args.surfaces.filter(
    (s): s is AeoChatSurface => !isAgentSurface(s),
  );

  const selectedAgentSurfaces = args.surfaces.filter(
    (s): s is AeoAgentSurface => isAgentSurface(s),
  );

  const promptInputs = args.prompts.map((p) => ({
    id: p.id,
    promptText: p.text,
    category: p.category,
  }));

  // Agent probes may cover a configured subset of prompts (the first N in
  // config order) at a configured run count; the chat batch always covers
  // every prompt, at the configured chat depth.
  const agentRunsPerPrompt = args.agentProbes.runsPerPrompt;
  const agentPromptInputs = agentProbedPrompts(promptInputs, args.agentProbes);

  // Store resume: split the section's planned units into cached hits
  // (reused as-is) and missing keys (the only units the probe batches run).
  const plannedUnits = plannedProbeUnitsForSection({
    sectionKey: args.sectionKey,
    prompts: args.prompts,
    surfaces: args.surfaces,
    agentProbes: args.agentProbes,
    chatProbes: args.chatProbes,
  });

  const unitByKey = new Map<string, ProbeUnit>();

  for (const unit of plannedUnits) {
    unitByKey.set(probeUnitKey(unit), unit);
  }

  const cachedProbes: Probe[] = [];
  const missingKeys = new Set<string>();
  let missingChat = 0;
  let missingAgent = 0;

  for (const unit of plannedUnits) {
    const record = (await args.probeStore?.get(unit)) ?? null;

    // A failed record never satisfies the lookup: the unit re-executes on
    // resume exactly as a missing entry does (§4.1).
    if (record?.status === 'captured') {
      cachedProbes.push(record.probe);
      continue;
    }

    missingKeys.add(probeUnitKey(unit));

    if (isAgentSurface(unit.surface)) {
      missingAgent += 1;
    } else {
      missingChat += 1;
    }
  }

  if (cachedProbes.length > 0) {
    log.info('Reusing stored probes', {
      ...args.logContext,
      cached: cachedProbes.length,
      planned: plannedUnits.length,
    });
  }

  const shouldRun = (unit: {
    promptId: string;
    surface: AeoSurface;
    runIndex: number;
  }) => {
    return missingKeys.has(
      probeUnitKey({ sectionKey: args.sectionKey, ...unit }),
    );
  };

  // Persist captures the moment they are usable: probes are the paid part of
  // a run, and the agent batch can run for an hour while the chat batch sits
  // finished in memory (a 2026-09-03 run would have lost 90 chat probes to
  // a Ctrl+C). A concurrent capture of the same unit (a
  // redelivered request) is refused by the store and logged; this run's
  // copy still feeds its analysis (§4.2).
  const bank = async (probe: Probe) => {
    if (!args.probeStore) {
      return;
    }

    try {
      await args.probeStore.put({
        status: 'captured',
        sectionKey: args.sectionKey,
        promptId: probe.promptId,
        promptText: probe.promptText,
        surface: probe.modelName,
        runIndex: probe.runIndex,
        runId: args.runId,
        capturedAt: new Date().toISOString(),
        captureMetadata: {
          requestedModel: capturedRequestedModel(
            probe,
            args.probeDependencies.bindings,
          ),
          reportedModel: probe.reportedModel ?? null,
          // Progress comparisons hash these into each answer's collection
          // method, so they stay as earlier releases recorded them. Chat
          // depth is left out: it does not change how one answer is
          // collected, and a depth difference already shows as a scope
          // change.
          parameters: {
            geography: args.geography,
            language: args.language,
            agentProbes: args.agentProbes,
          },
          ...recordedAdapterOf(
            probe.modelName,
            args.probeDependencies.bindings,
          ),
        },
        probe,
      });
    } catch (error) {
      if (!(error instanceof UnitConflictError)) {
        throw error;
      }

      log.warn('Unit already captured in the store; keeping the stored copy', {
        ...args.logContext,
        promptId: probe.promptId,
        surface: probe.modelName,
        runIndex: probe.runIndex,
      });
    }
  };

  // Both batches fan out together through the shared per-provider pools.
  const trace = args.trace && withSection(args.trace, args.sectionKey);

  // Per-class guards: an all-cached class skips its batch entirely instead
  // of running an empty fan-out that logs "0 probes completed".
  const [chatOutcomes, agentBatch] = await Promise.all([
    selectedChatSurfaces.length > 0 && missingChat > 0
      ? runProbesForPrompts(
          {
            geography: args.geography,
            language: args.language,
            prompts: promptInputs,
            surfaces: selectedChatSurfaces,
            chatProbes: args.chatProbes,
            filter: shouldRun,
            onResult: bank,
            trace,
            limiter: args.limiter,
            signal: args.signal,
            dependencies: args.probeDependencies,
          },
          { logContext: args.logContext },
        )
      : Promise.resolve<ProbeOutcome<ProbeResult>[]>([]),
    selectedAgentSurfaces.length > 0 && missingAgent > 0
      ? runAgentProbesForPrompts({
          prompts: agentPromptInputs,
          surfaces: selectedAgentSurfaces,
          versions: args.agentCliVersions,
          runsPerPrompt: agentRunsPerPrompt,
          filter: shouldRun,
          onResult: bank,
          trace,
          limiter: args.limiter,
          runtime: args.agentRuntime,
          signal: args.signal,
          logContext: args.logContext,
        })
      : Promise.resolve<{
          outcomes: ProbeOutcome<AgentProbeResult>[];
          rejectedWebToolSurfaces: AeoAgentSurface[];
        }>({
          outcomes: [],
          rejectedWebToolSurfaces: [],
        }),
  ]);

  // Every failed unit becomes a stored record (§4.1) so a resumed run can
  // tell "never attempted" from "failed an hour ago". A store that cannot
  // take the record is logged, not fatal: the failure is still counted.
  const freshChatProbes: ProbeResult[] = [];
  const freshAgentProbes: AgentProbeResult[] = [];
  const unitFailures: UnitFailureSummary[] = [];
  const outcomes: ProbeOutcome<Probe>[] = [
    ...chatOutcomes,
    ...agentBatch.outcomes,
  ];

  for (const outcome of outcomes) {
    if (outcome.status === 'captured') {
      if (isAgentProbe(outcome.probe)) {
        freshAgentProbes.push(outcome.probe);
      } else {
        freshChatProbes.push(outcome.probe);
      }

      continue;
    }

    unitFailures.push({
      ...outcome.unit,
      kind: outcome.kind,
      attempts: outcome.attempts,
    });

    // A unit the shutdown signal stopped before its first attempt was never
    // tried: it stays a missing unit, not a failed one.
    if (outcome.attempts === 0) {
      continue;
    }

    const unit = unitByKey.get(
      probeUnitKey({ sectionKey: args.sectionKey, ...outcome.unit }),
    );

    if (!unit || !args.probeStore) {
      continue;
    }

    try {
      await args.probeStore.put({
        status: 'failed',
        ...unit,
        runId: args.runId,
        failedAt: new Date().toISOString(),
        kind: outcome.kind,
        attempts: outcome.attempts,
        lastError: outcome.lastError,
      });
    } catch (error) {
      log.error('Could not record a failed unit', error, {
        ...args.logContext,
        ...outcome.unit,
      });
    }
  }

  const probes: Probe[] = [
    ...cachedProbes,
    ...freshChatProbes,
    ...freshAgentProbes,
  ];

  // Coverage per surface (§4.1): what the plan asked for versus what this
  // run can account for as captured, store hits included.
  const coverage: SurfaceCoverage[] = args.surfaces.map((surface) => ({
    surface,
    planned: plannedUnits.filter((u) => u.surface === surface).length,
    captured: probes.filter((p) => p.modelName === surface).length,
  }));

  const capturedPromptIds = new Set(probes.map((p) => p.promptId));
  const lostPromptIds = args.prompts
    .filter((p) => !capturedPromptIds.has(p.id))
    .map((p) => p.id);

  return {
    probes,
    coverage,
    lostPromptIds,
    unitFailures,
    rejectedWebToolSurfaces: agentBatch.rejectedWebToolSurfaces,
    freshChatRetrieval: freshChatProbes.map((probe) => ({
      surface: probe.modelName,
      retrievalCalls: probe.retrieval ? probe.retrieval.calls.length : null,
    })),
    freshAgentRetrieval: freshAgentProbes.map((probe) => ({
      surface: probe.modelName,
      usedWebSearch: probe.usedWebSearch,
    })),
  };
};
