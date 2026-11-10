import type {
  CaptureArtifact,
  SectionCaptureArtifact,
} from '../harness/report/artifacts';
import { captureCoverageIssues } from '../harness/report/capture-coverage';
import { unitRecordKey } from '../lib/checkpoint';
import type { InternalModelContext } from '../models/context';
import { captureSectionProbes, type SectionRunArgs } from '../pipeline';
import type { AgentCliVersions, AgentRuntime } from '../probes/agent-clis';
import type { ProbeLimiter } from '../probes/limits';
import type { RunPlan } from '../runner';
import type { AeoAuditConfig, RunRequest } from '../schema';
import { contentHash } from '../stores/content-hash';
import type { CapturedUnitRecord, ProbeStore, Stores } from '../stores/ports';
import { parseUnitRecord } from '../stores/unit-record';
import { isAgentSurface, type AeoAgentSurface } from '../surfaces';
import type { ProbeTrace } from '../probes/probe-trace';
import {
  bankBindingMismatches,
  RunBindingsError,
  type ProbeDependencies,
  type RunBindings,
} from '../probes/bindings';

// ============================================================================
// The paid half of a run: every planned probe unit captured or reused from
// the bank, per section, summarised as the capture artifact the rest of the
// workflow reads. Banked captures are reused on every attempt, so a
// transient provider condition (a section that returned nothing, a coverage
// shortfall) asks for another attempt rather than another capture.
// ============================================================================

export type CaptureDeps = {
  config: AeoAuditConfig;
  request: RunRequest;
  plan: RunPlan;
  stores: Stores;
  agentCliVersions: AgentCliVersions;
  agentRuntime?: AgentRuntime;
  limiter: ProbeLimiter;
  internalModels?: InternalModelContext;
  /** The run journal, when the capture is recorded (a local run). */
  trace?: ProbeTrace;
  signal?: AbortSignal;
  /** What the probe adapters are created with: the gateway, credentials,
   * clients. */
  probeDependencies: ProbeDependencies;
  logContext: Record<string, unknown>;
  now?: () => Date;
  /** The section capture service; tests inject one. */
  captureSection?: typeof captureSectionProbes;
};

/** A condition another attempt can clear by reusing the bank and probing
 * only what is missing; never a reason to recapture. */
export class CaptureRetryableError extends Error {}

/** The agent surfaces this attempt still has to probe: those with at least
 * one planned unit the bank does not hold. A retry whose bank is complete
 * needs neither the CLI nor its credential, so the pre-flight (auth, install,
 * canary) covers only these. */
export const agentSurfacesToCapture = async (
  plan: RunPlan,
  probeStore: Pick<ProbeStore, 'list'>,
): Promise<AeoAgentSurface[]> => {
  const banked = new Set(
    (await probeStore.list())
      .filter((entry) => entry.status === 'captured')
      .map(unitRecordKey),
  );

  const pending = new Set<AeoAgentSurface>();

  for (const unit of plan.units) {
    if (isAgentSurface(unit.surface) && !banked.has(unitRecordKey(unit))) {
      pending.add(unit.surface);
    }
  }

  return plan.agentSurfaces.filter((surface) => pending.has(surface));
};

const sectionArgs = (
  deps: CaptureDeps,
  section: AeoAuditConfig['sections'][number],
): SectionRunArgs => {
  return {
    sectionKey: section.key,
    brand: deps.config.brand,
    competitors: section.competitors ?? deps.config.competitors,
    prompts: section.prompts,
    geography: deps.config.geography,
    language: deps.config.language,
    surfaces: deps.plan.surfaces,
    agentProbes: deps.config.agentProbes,
    chatProbes: deps.config.chatProbes,
    agentCliVersions: deps.agentCliVersions,
    runId: deps.request.runId,
    probeStore: deps.stores.probeStore,
    analysisStore: deps.stores.analysisStore,
    limiter: deps.limiter,
    agentRuntime: deps.agentRuntime,
    trace: deps.trace,
    signal: deps.signal,
    probeDependencies: deps.probeDependencies,
    internalModels: deps.internalModels,
    logContext: { ...deps.logContext, sectionKey: section.key },
  };
};

/**
 * assertBankUsable refuses a bank the run cannot build on, before anything
 * is dispatched: a row no release wrote (phase 3 item 6), or a banked
 * answer the plan reuses that another binding captured. captureForRun runs
 * it before its first section, where the sections would otherwise settle
 * independently and spend while one fails; a host runs it before its agent
 * canaries too.
 */
export const assertBankUsable = async (
  probeStore: Pick<ProbeStore, 'list'>,
  plan: RunPlan,
  bindings: RunBindings,
): Promise<void> => {
  const banked = await probeStore.list();

  for (const record of banked) {
    parseUnitRecord(record, unitRecordKey(record));
  }

  // A banked answer is reused only under the binding that captured it, its
  // model included; a mismatch stops the run, never re-probed silently.
  const plannedKeys = new Set(plan.units.map(unitRecordKey));
  const mismatched = bankBindingMismatches(
    banked.filter(
      (record): record is CapturedUnitRecord =>
        record.status === 'captured' && plannedKeys.has(unitRecordKey(record)),
    ),
    bindings,
  );

  if (mismatched.length > 0) {
    const surfaces = [...new Set(mismatched.map((record) => record.surface))];
    const bound = surfaces
      .map((surface) => {
        const { adapter, model } = bindings[surface];

        return `${surface} (${model === undefined ? adapter : `${adapter}, ${model}`})`;
      })
      .join(', ');

    throw new RunBindingsError(
      `${mismatched.length} banked answers were captured with another adapter or model than this run's binding of ${bound}. A banked answer is never probed again under another binding: start a fresh run (a new run directory, or mode fresh) to measure them this way.`,
    );
  }
};

/** Orders by UTF-16 code units, independent of the host's locale. */
const compareCodeUnits = (left: string, right: string) => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

export const captureForRun = async (
  deps: CaptureDeps,
): Promise<CaptureArtifact> => {
  const { config, plan } = deps;
  const now = deps.now ?? (() => new Date());
  const captureSection = deps.captureSection ?? captureSectionProbes;

  await assertBankUsable(
    deps.stores.probeStore,
    plan,
    deps.probeDependencies.bindings,
  );

  const startedAt = now().toISOString();
  const settled = await Promise.allSettled(
    plan.sections.map((section) => captureSection(sectionArgs(deps, section))),
  );
  const sections: Record<string, SectionCaptureArtifact> = {};
  const failedSections: CaptureArtifact['failedSections'] = [];

  for (const [index, section] of plan.sections.entries()) {
    const outcome = settled[index];

    if (!outcome) {
      throw new Error(
        `Capture settled no outcome for section: ${section.key}.`,
      );
    }

    if (outcome.status === 'rejected') {
      failedSections.push({
        key: section.key,
        error: (outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason)
        ).slice(0, 500),
      });
      continue;
    }

    const capture = outcome.value;

    if (capture.probes.length === 0) {
      failedSections.push({
        key: section.key,
        error: 'Section probes returned no results',
      });
      continue;
    }

    const units: SectionCaptureArtifact['units'] = [];

    for (const probe of capture.probes) {
      const unit = {
        sectionKey: section.key,
        promptId: probe.promptId,
        promptText: probe.promptText,
        surface: probe.modelName,
        runIndex: probe.runIndex,
      };

      const record = await deps.stores.probeStore.get(unit);

      if (record?.status !== 'captured') {
        throw new Error(
          `Capture was not banked in the probe store: ${unitRecordKey(unit)}.`,
        );
      }

      units.push({
        unitKey: unitRecordKey(unit),
        promptId: probe.promptId,
        surface: probe.modelName,
        runIndex: probe.runIndex,
        rawDigest: contentHash(record.probe.text),
        capturedAt: record.capturedAt,
      });
    }

    units.sort((left, right) => compareCodeUnits(left.unitKey, right.unitKey));
    sections[section.key] = {
      units,
      coverage: capture.coverage,
      lostPromptIds: capture.lostPromptIds,
      unitFailures: capture.unitFailures,
      rejectedWebToolSurfaces: capture.rejectedWebToolSurfaces,
      freshChatRetrieval: capture.freshChatRetrieval,
      freshAgentRetrieval: capture.freshAgentRetrieval,
    };
  }

  if (!Object.keys(sections).length) {
    throw new CaptureRetryableError('All sections failed to capture');
  }

  deps.signal?.throwIfAborted();

  let resumedCount = 0;
  let oldest: string | null = null;
  const planned = new Set(plan.units.map(unitRecordKey));
  const captured = (await deps.stores.probeStore.list()).filter(
    (entry): entry is CapturedUnitRecord => entry.status === 'captured',
  );

  for (const record of captured) {
    if (!planned.has(unitRecordKey(record))) {
      continue;
    }

    if (record.runId === deps.request.runId) {
      continue;
    }

    resumedCount += 1;

    if (!oldest || record.capturedAt < oldest) {
      oldest = record.capturedAt;
    }
  }

  const artifact: CaptureArtifact = {
    version: 1,
    reportKey: config.reportKey,
    runId: deps.request.runId,
    planDigest: contentHash(plan.units.map(unitRecordKey)),
    plannedUnits: plan.units.length,
    surfaces: [...plan.surfaces],
    sections,
    failedSections,
    resumed: {
      count: resumedCount,
      total: plan.units.length,
      oldestCapturedAt: oldest,
    },
    agentCliVersions: { ...deps.agentCliVersions },
    startedAt,
    completedAt: now().toISOString(),
  };

  // A coverage shortfall is transient: the next attempt reuses every banked
  // capture and probes only the missing units.
  const shortfall = captureCoverageIssues(
    artifact,
    plan.surfaces,
    deps.request.coverageThresholds,
  );

  if (shortfall.length) {
    throw new CaptureRetryableError(
      `Capture coverage short: ${shortfall.slice(0, 3).join('; ')}`,
    );
  }

  return artifact;
};
