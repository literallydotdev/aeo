import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { measurementDigest, RunOrigin } from '../bundle/contracts';
import {
  openRecorder,
  probeTraceOf,
  recordedOperationKinds,
  recordingAccounting,
  type ExecutionRecorder,
} from '../bundle/recorder';
import { acquireWriterLock, type WriterLock } from '../bundle/writer-lock';
import { capturePlan } from '../capture-manifest';
import {
  assertBankUsable,
  captureForRun,
  agentSurfacesToCapture,
} from '../codex-workflow/capture';
import type { GroundRun } from '../codex-workflow/finish';
import {
  localTechnicalChecks,
  persistedRunId,
  type RunSource,
} from '../codex-workflow/run-source';
import { runInputsFile } from '../codex-workflow/run-inputs';
import {
  assertAgentClis,
  detectAgentClis,
  runCanaryProbes,
} from '../probes/agent-clis';
import { createFileResearchSessionStore } from '../grounding/file-store';
import { openGroundingRuntime } from '../grounding/grounding-runtime';
import {
  createFileModelAccounting,
  type ModelCallAccounting,
} from '../models/accounting';
import type { ModelCatalogSource } from '../models/catalog';
import {
  recommendedModelId,
  type SupportedModel,
} from '../models/supported-models';
import { chargedProbeTrace } from '../probes/charged-trace';
import { catalogPricedModels, probeDependenciesOf } from '../probes/bindings';
import type { InternalModelContext } from '../models/context';
import { ProbeLimiter } from '../probes/limits';
import { planRun, type RunPlan } from '../runner';
import type { AeoAuditConfig, RunRequest } from '../schema';
import { hasErrorCode } from '../stores/fs-errors';
import { openFileStores } from '../stores/files';
import type { CapturedUnitRecord } from '../stores/ports';
import { getEnvironment } from '../lib/env';
import {
  requestedBindings,
  toAuditConfig,
  toRunRequest,
  type AuditFile,
} from './audit-file';
import { resolveRunBindings } from './run-bindings';
import {
  recordedCatalogSource,
  resolveReportModel,
  resolveRunModels,
} from './run-models';
import { bankDir } from './run-configuration';
import { resolveRunMethod } from './run-method';
import {
  readFrozenBudget,
  resolveRunBudget,
  type BudgetAmendment,
  type RunBudget,
} from './budget';

// ============================================================================
// A local run (specs/aeo-open-source-cli-spec.md §3.3, §4.3): audit.json in,
// a run directory out, no database. The run directory is the work directory
// the workflow writes, plus BANK/ for the probe bank, the analysis cache and
// the report store. Running again over the same directory resumes it: every
// banked answer is reused and only a missing unit is probed.
// ============================================================================

export type LocalPlan = {
  config: AeoAuditConfig;
  request: RunRequest;
  plan: RunPlan;
  digests: { measurement: string; plan: string };
};

/** planLocalRun resolves what a run would measure; no I/O, no network. */
export const planLocalRun = (
  file: AuditFile,
  runId = 'planned',
  /** The report model once resolved; the engine's own entry when absent. */
  model?: SupportedModel,
): LocalPlan => {
  const config = toAuditConfig(file);
  const request = toRunRequest(file, runId, { ...(model && { model }) });
  const plan = planRun(config, request);

  const localPlan: LocalPlan = {
    config,
    request,
    plan,
    digests: {
      measurement: measurementDigest({
        config,
        surfaces: plan.surfaces,
        sections: request.sections ?? null,
      }),
      plan: capturePlan(config, plan.surfaces, request.sections).digest,
    },
  };

  return localPlan;
};

/** What a file measures, as digests. They do not depend on the report
 * model, so none is resolved or priced to compute them. */
export const localRunDigests = (
  file: AuditFile,
  runId = 'planned',
): LocalPlan['digests'] => {
  return planLocalRun({ ...file, model: undefined }, runId).digests;
};

/** Whether full grounding will search through the pinned provider, so its
 * credential is a preflight requirement, not a mid-run surprise. */
export const usesGroundingSearch = (request: RunRequest): boolean => {
  return (
    request.grounding === 'full' &&
    request.modelProfile?.searchProvider === 'dataforseo-google-organic-v1'
  );
};

export type RunDirectoryState = 'new' | 'resumable' | 'completed';

/** What running again over a directory would do: start, resume or return
 * the completed result. */
export const runDirectoryState = async (
  dir: string,
): Promise<RunDirectoryState> => {
  const exists = async (file: string) => {
    return readFile(path.join(dir, file)).then(
      () => true,
      (err: unknown) => {
        if (hasErrorCode(err, 'ENOENT')) {
          return false;
        }

        throw err;
      },
    );
  };

  if (await exists('SCORECARD.json')) {
    return 'completed';
  }

  return (await exists(runInputsFile)) ? 'resumable' : 'new';
};

/** Thrown before any paid work when an agent surface cannot be probed. */
export class PreflightFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PreflightFailedError';
  }
}

export type LocalRun = {
  source: RunSource;
  budget: RunBudget;
  /** The run's pinned model context: every host call charges its ledger
   * and is recorded in the run journal. */
  internalModels: InternalModelContext;
  /** The same ledger unwrapped, for the Codex sessions, which the journal
   * records as operations of their own. */
  ledger: ModelCallAccounting;
  ground: GroundRun;
  /** The directory's writer lock and its run journal, held from before the
   * first canary: the workflow continues under both (prepareWorkdir held). */
  held: { writer: WriterLock; recorder: ExecutionRecorder };
};

/**
 * openLocalRun takes the run directory's writer lock and opens its journal,
 * freezes the run's budget, captures what the bank lacks and returns the
 * run's inputs with its model ledger and grounding. Agent surfaces with
 * answers still to capture are checked first (installed, then a canary
 * probe), so a missing login stops the run before the audit workload, never
 * halfway through it. Every canary, probe attempt, technical check, host
 * model call and research tool call from here on is a journal operation.
 */
export const openLocalRun = async (
  file: AuditFile,
  dir: string,
  options: {
    signal?: AbortSignal;
    /** The cap approved on the command line (`run --max-usd`). */
    maxUsd?: number;
    amendment?: BudgetAmendment;
    derivedFromRunId?: string;
    /** Where a report model the engine has no entry for is priced from;
     * without one, such a model is refused. */
    catalog?: ModelCatalogSource;
  } = {},
): Promise<LocalRun> => {
  await mkdir(dir, { recursive: true });

  const writer = await acquireWriterLock(dir, 'literally-aeo run');
  let recorder: ExecutionRecorder | undefined;

  try {
    const runId = await persistedRunId(dir);
    // The report model is resolved, and its price frozen, only once the
    // directory's method is known to match (openLockedLocalRun).
    const digests = localRunDigests(file, runId);

    recorder = await openRecorder(dir, {
      origin: RunOrigin.LOCAL,
      runId,
      measurementDigest: digests.measurement,
      planDigest: digests.plan,
      observes: recordedOperationKinds,
      ...(writer.takenOver && { takenOver: writer.takenOver }),
    });

    return await openLockedLocalRun(file, dir, {
      ...options,
      runId,
      held: { writer, recorder },
    });
  } catch (err) {
    // The workflow records its own end; a stop before it is recorded here.
    await recorder
      ?.record(options.signal?.aborted ? 'run_interrupted' : 'run_failed', {
        error: err instanceof Error ? err.name : typeof err,
        reason: (err instanceof Error ? err.message : String(err)).slice(
          0,
          500,
        ),
      })
      .catch(() => undefined);
    await writer.release();

    throw err;
  }
};

const openLockedLocalRun = async (
  file: AuditFile,
  dir: string,
  {
    signal,
    maxUsd,
    amendment,
    derivedFromRunId,
    catalog,
    runId,
    held,
  }: {
    signal?: AbortSignal;
    maxUsd?: number;
    amendment?: BudgetAmendment;
    derivedFromRunId?: string;
    catalog?: ModelCatalogSource;
    runId: string;
    held: LocalRun['held'];
  },
): Promise<LocalRun> => {
  const { recorder } = held;
  const bank = path.join(dir, bankDir);
  // The method and the bindings are frozen before the budget and the first
  // canary, then kept on every resume: a directory that holds a budget but
  // not them started before they were frozen. Frozen after the budget, an
  // attempt stopped between the two (a refused plan, a crash) would read as
  // one. The method comes first, so a refused directory gains no file.
  const frozenBudget = await readFrozenBudget(dir);
  const startedBefore = frozenBudget !== undefined;

  await resolveRunMethod(dir, bank, { startedBefore });

  // A resume under another report model is the budget's to refuse. It is
  // asked first, so the refused directory gains no price for that model.
  const namedModel = file.model ?? recommendedModelId;

  if (frozenBudget?.model !== undefined && frozenBudget.model !== namedModel) {
    await resolveRunBudget(dir, file.runPolicy.budget, { model: namedModel });
  }

  const bindings = await resolveRunBindings(bank, {
    startedBefore,
    requested: requestedBindings(file),
  });
  const pricing = {
    source: catalog && recordedCatalogSource(catalog, recorder),
    now: new Date(),
    freeze: true,
  };
  const model = await resolveReportModel(file.model, bank, pricing);
  // A bound model the engine has no flat figure for is reserved at its
  // catalog price, frozen here with the report model's.
  const probeModels = new Map(
    (
      await resolveRunModels(
        bank,
        catalogPricedModels(bindings, file.surfaces),
        pricing,
      )
    ).map((entry) => [entry.model.id, entry.model]),
  );
  const budget = await resolveRunBudget(dir, file.runPolicy.budget, {
    model: model.id,
    ...(maxUsd !== undefined && { maxUsd }),
    ...(amendment && { amendment }),
  });
  const config = toAuditConfig(file);
  const request = {
    ...toRunRequest(file, runId, { modelBudget: budget.limits, model }),
    ...(derivedFromRunId !== undefined && { derivedFromRunId }),
  };
  const plan = planRun(config, request);
  const stores = await openFileStores(config.reportKey, {
    checkpointDir: bank,
    contentDir: path.join(bank, 'report'),
  });
  // The writer lock owns the directory; ownership here is only whether the
  // operator stopped the run.
  const assertOwned = () => {
    signal?.throwIfAborted();

    return Promise.resolve();
  };
  // One ledger for every paid call of the run: probes, Codex sessions,
  // host model calls and searches (specs/aeo-claude-operator-spec.md §4.2).
  const ledger = createFileModelAccounting({
    filename: path.join(bank, 'model-budget.json'),
    limits: budget.limits,
    assertOwned,
  });
  const grounding = openGroundingRuntime({
    request,
    config,
    analysisStore: stores.analysisStore,
    env: getEnvironment(),
    signal,
    rawAccounting: ledger,
    store: createFileResearchSessionStore(
      path.join(bank, 'research'),
      assertOwned,
    ),
    owner: { kind: 'run', runId },
    recorder,
    close: () => Promise.resolve(),
  });
  const internalModels: InternalModelContext = {
    ...grounding.internalModels,
    accounting: recordingAccounting(
      grounding.internalModels.accounting,
      recorder,
    ),
  };
  // Before the canaries, which dispatch: a bank the run cannot build on
  // stops it with nothing sent.
  await assertBankUsable(stores.probeStore, plan, bindings);
  const agents = await agentSurfacesToCapture(plan, stores.probeStore);
  const agentCliVersions = await detectAgentClis();

  try {
    assertAgentClis(agents, agentCliVersions);
    await runCanaryProbes(
      agents,
      { env: getEnvironment(), claudeConfigDir: null },
      { signal, trace: probeTraceOf(recorder, 'canary') },
    );
  } catch (err) {
    throw new PreflightFailedError(
      `An agent surface cannot be probed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const probes = chargedProbeTrace(probeTraceOf(recorder, 'probe'), ledger, {
    bindings,
    priced: probeModels,
  });
  const capture = await captureForRun({
    probeDependencies: probeDependenciesOf(getEnvironment(), bindings),
    config,
    request,
    plan,
    stores,
    agentCliVersions,
    limiter: new ProbeLimiter(request.limits),
    internalModels,
    trace: probes.trace,
    signal,
    logContext: { reportKey: config.reportKey, runId, local: true },
  }).catch((err: unknown) => {
    // A unit the cap refused fails as unrecorded, and the capture may
    // report only the shortfall: the cap is the reason, and the run stops
    // resumable with everything captured so far banked.
    throw probes.exhausted() ?? err;
  });
  const exhausted = probes.exhausted();

  if (exhausted) {
    throw exhausted;
  }

  const captured = (await stores.probeStore.list()).filter(
    (entry): entry is CapturedUnitRecord => entry.status === 'captured',
  );

  const source: RunSource = {
    id: config.reportKey,
    reportKey: config.reportKey,
    config,
    request,
    plan,
    surfaces: plan.surfaces,
    capture,
    captured,
    technical: await localTechnicalChecks(config, dir, recorder),
    grounding: null,
    stores,
    close: () => grounding.close(),
  };

  const run: LocalRun = {
    source,
    budget,
    internalModels,
    ledger,
    ground: (manifest, options) => grounding.ground(manifest, options),
    held,
  };

  return run;
};
