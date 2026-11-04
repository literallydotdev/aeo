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
import { createFileModelAccounting } from '../models/accounting';
import type { InternalModelContext } from '../models/context';
import { ProbeLimiter } from '../probes/limits';
import { planRun, type RunPlan } from '../runner';
import type { AeoAuditConfig, RunRequest } from '../schema';
import { hasErrorCode } from '../stores/fs-errors';
import { openFileStores } from '../stores/files';
import type { CapturedUnitRecord } from '../stores/ports';
import { getEnvironment } from '../lib/env';
import { toAuditConfig, toRunRequest, type AuditFile } from './audit-file';
import {
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

export const bankDir = 'BANK';

export type LocalPlan = {
  config: AeoAuditConfig;
  request: RunRequest;
  plan: RunPlan;
  digests: { measurement: string; plan: string };
};

/** planLocalRun resolves what a run would measure; no I/O, no network. */
export const planLocalRun = (file: AuditFile, runId = 'planned'): LocalPlan => {
  const config = toAuditConfig(file);
  const request = toRunRequest(file, runId);
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
    amendment?: BudgetAmendment;
    derivedFromRunId?: string;
  } = {},
): Promise<LocalRun> => {
  await mkdir(dir, { recursive: true });

  const writer = await acquireWriterLock(dir, 'literally-aeo run');
  let recorder: ExecutionRecorder | undefined;

  try {
    const runId = await persistedRunId(dir);
    const planned = planLocalRun(file, runId);

    recorder = await openRecorder(dir, {
      origin: RunOrigin.LOCAL,
      runId,
      measurementDigest: planned.digests.measurement,
      planDigest: planned.digests.plan,
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
    amendment,
    derivedFromRunId,
    runId,
    held,
  }: {
    signal?: AbortSignal;
    amendment?: BudgetAmendment;
    derivedFromRunId?: string;
    runId: string;
    held: LocalRun['held'];
  },
): Promise<LocalRun> => {
  const { recorder } = held;
  const budget = await resolveRunBudget(dir, file.runPolicy.budget, {
    amendment,
  });
  const config = toAuditConfig(file);
  const request = {
    ...toRunRequest(file, runId, budget.limits),
    ...(derivedFromRunId !== undefined && { derivedFromRunId }),
  };
  const plan = planRun(config, request);
  const bank = path.join(dir, bankDir);
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
  const grounding = openGroundingRuntime({
    request,
    config,
    analysisStore: stores.analysisStore,
    env: getEnvironment(),
    signal,
    rawAccounting: createFileModelAccounting({
      filename: path.join(bank, 'model-budget.json'),
      limits: budget.limits,
      assertOwned,
    }),
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

  const capture = await captureForRun({
    config,
    request,
    plan,
    stores,
    agentCliVersions,
    limiter: new ProbeLimiter(request.limits),
    internalModels,
    trace: probeTraceOf(recorder, 'probe'),
    signal,
    logContext: { reportKey: config.reportKey, runId, local: true },
  });
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
    ground: (manifest, options) => grounding.ground(manifest, options),
    held,
  };

  return run;
};
