import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BundleEvent } from '../bundle/contracts';
import { readJournal } from '../bundle/journal';
import { runJournalDir } from '../bundle/recorder';
import { readWriterLock, type WriterLockState } from '../bundle/writer-lock';
import { readRunInputs } from '../codex-workflow/run-inputs';
import { unitRecordKey } from '../lib/checkpoint';
import { chargedCall } from '../models/accounting';
import { hasErrorCode } from '../stores/fs-errors';
import { FileProbeStore } from '../stores/files';
import { capturePlan } from '../capture-manifest';
import { localReportKey, readAuditFile, toAuditConfig } from './audit-file';
import { budgetFile } from './budget';
import { runDirectoryState } from './local-run';
import { auditCopyFile, bankDir } from './run-configuration';

// ============================================================================
// `literally-aeo status` (specs/aeo-claude-operator-spec.md §4.5): a
// read-only view of a run directory for whoever watches a run, a person or
// an agent polling it. It reads the journal, the ledger, the frozen budget
// and the bank; it never takes the writer lock and never writes, so it is
// safe beside a live writer. What a file does not say is reported as
// unknown, never filled in.
// ============================================================================

export const SpendCategory = {
  PROBES: 'probes',
  STAGES: 'stages',
  HOST_CALLS: 'hostCalls',
  SEARCH: 'search',
} as const;

export type SpendCategory = (typeof SpendCategory)[keyof typeof SpendCategory];

/** spendCategoryOf names the kind of paid work a ledger role charges:
 * `stage:` Codex sessions, `probe:` assistant answers, `search:` and
 * grounding's research searches, everything else the host's model calls. */
export const spendCategoryOf = (role: string): SpendCategory => {
  if (role.startsWith('stage:')) {
    return SpendCategory.STAGES;
  }

  if (role.startsWith('probe:')) {
    return SpendCategory.PROBES;
  }

  if (role.startsWith('search:') || role === 'research_search') {
    return SpendCategory.SEARCH;
  }

  return SpendCategory.HOST_CALLS;
};

// The ledger as BANK/model-budget.json holds it (src/models/accounting.ts),
// read loosely: status reports what is there and never refuses a ledger a
// newer engine wrote.
const ledgerCallSchema = z.looseObject({
  callId: z.string(),
  role: z.string(),
  reservedUsd: z.number(),
  inputTokens: z.number(),
  maxOutputTokens: z.number(),
  usage: z
    .looseObject({
      costUsd: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
});

const ledgerSchema = z.looseObject({
  limits: z.looseObject({ maxUsd: z.number(), deadlineAt: z.string() }),
  calls: z.record(z.string(), ledgerCallSchema),
});

const budgetStateSchema = z.looseObject({
  current: z.looseObject({ maxUsd: z.number() }),
  deadlineAt: z.string(),
  model: z.string().optional(),
});

export type CategorySpend = { usd: number; calls: number };

export type RunSpend = {
  currency: 'USD';
  /** The run's frozen cap; undefined before the first run froze one. */
  capUsd: number | undefined;
  /** The model the run froze with its cap. */
  model: string | undefined;
  deadlineAt: string | undefined;
  /** What every call charges: settled cost, else its reservation. */
  chargedUsd: number;
  /** Settled calls: at their reported cost, or at their reservation when
   * the provider reported none. */
  settledUsd: number;
  /** Calls reserved and not settled: dispatched, or lost with a process. */
  openUsd: number;
  remainingUsd: number | undefined;
  byCategory: Record<SpendCategory, CategorySpend>;
};

export type RunActivity = {
  kind: string;
  /** The Codex stage, for a session. */
  stage: string | undefined;
  /** The model role or surface, for a host call or probe. */
  role: string | undefined;
  at: string;
  /** Started and not yet finished. */
  open: boolean;
};

export type RunStatus = {
  dir: string;
  state: 'new' | 'resumable' | 'completed';
  writer:
    | {
        purpose: string;
        pid: number;
        host: string;
        since: string;
        state: WriterLockState;
      }
    | undefined;
  /** The run's phase as its journal shows it last. */
  phase: string | undefined;
  lastActivity: RunActivity | undefined;
  /** The Codex stage outputs present in OUT/. */
  completedStages: string[];
  answers: { planned: number | undefined; captured: number; failed: number };
  spend: RunSpend;
  lastError:
    { type: string; error: string; reason: string; at: string } | undefined;
  stoppedAtBudget: boolean;
};

const workflowStages = ['analyze', 'qualify', 'review', 'write'] as const;

const readText = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  }
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);

    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) {
      return false;
    }

    throw err;
  }
};

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    // A file torn by a live writer reads as absent until it is whole.
    return undefined;
  }
};

const readEvents = async (dir: string): Promise<BundleEvent[]> => {
  const text = await readText(path.join(dir, runJournalDir, 'events.jsonl'));

  // A damaged chain still reports the events before the damage.
  return text === undefined ? [] : readJournal(text).events;
};

const stringField = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

const phaseOf = (activity: RunActivity): string => {
  switch (activity.kind) {
    case 'probe':
    case 'canary':
      return 'capture';

    case 'technical_check':
      return 'technical checks';

    case 'research_tool':
      return 'grounding';

    case 'codex_session':
      return activity.stage ?? 'codex session';

    default:
      return activity.role ?? activity.kind;
  }
};

const lastActivityOf = (
  events: readonly BundleEvent[],
): RunActivity | undefined => {
  const started = events.findLast(
    (event) => event.type === 'operation_started',
  );

  if (!started) {
    return undefined;
  }

  const finished = events.some(
    (event) =>
      event.type === 'operation_finished' &&
      event.operationId === started.operationId,
  );

  const activity: RunActivity = {
    kind: stringField(started.payload.kind) ?? 'unknown',
    stage: stringField(started.payload.stage),
    role: stringField(started.payload.role),
    at: started.at,
    open: !finished,
  };

  return activity;
};

/** The workflow's own end, when the journal's latest writer recorded one. */
const endOf = (events: readonly BundleEvent[]): BundleEvent | undefined => {
  const writerStart = events.findLastIndex(
    (event) => event.type === 'run_started' || event.type === 'run_resumed',
  );
  const end = events
    .slice(Math.max(writerStart, 0))
    .findLast((event) =>
      ['run_completed', 'run_failed', 'run_interrupted'].includes(event.type),
    );

  return end;
};

const lastErrorOf = (
  events: readonly BundleEvent[],
): RunStatus['lastError'] => {
  const failure = events.findLast(
    (event) => event.type === 'run_failed' || event.type === 'run_interrupted',
  );

  if (!failure) {
    return undefined;
  }

  const lastError = {
    type: failure.type,
    error: stringField(failure.payload.error) ?? 'unknown',
    reason: stringField(failure.payload.reason) ?? '',
    at: failure.at,
  };

  return lastError;
};

const emptySpend = (): Record<SpendCategory, CategorySpend> => {
  return {
    probes: { usd: 0, calls: 0 },
    stages: { usd: 0, calls: 0 },
    hostCalls: { usd: 0, calls: 0 },
    search: { usd: 0, calls: 0 },
  };
};

const readSpend = async (dir: string): Promise<RunSpend> => {
  const ledger = ledgerSchema.safeParse(
    parseJson(await readText(path.join(dir, bankDir, 'model-budget.json'))),
  );
  const budget = budgetStateSchema.safeParse(
    parseJson(await readText(path.join(dir, budgetFile))),
  );
  const limits = ledger.success ? ledger.data.limits : undefined;
  const byCategory = emptySpend();
  let settledUsd = 0;
  let openUsd = 0;

  for (const call of Object.values(ledger.success ? ledger.data.calls : {})) {
    const charge = chargedCall(call);
    const category = byCategory[spendCategoryOf(call.role)];

    category.usd += charge.usd;
    category.calls += 1;

    if (call.usage === undefined) {
      openUsd += charge.usd;
    } else {
      settledUsd += charge.usd;
    }
  }

  const capUsd = budget.success ? budget.data.current.maxUsd : limits?.maxUsd;
  const chargedUsd = settledUsd + openUsd;

  const spend: RunSpend = {
    currency: 'USD',
    capUsd,
    model: budget.success ? budget.data.model : undefined,
    deadlineAt: budget.success ? budget.data.deadlineAt : limits?.deadlineAt,
    chargedUsd,
    settledUsd,
    openUsd,
    remainingUsd:
      capUsd === undefined ? undefined : Math.max(capUsd - chargedUsd, 0),
    byCategory,
  };

  return spend;
};

/** The planned unit keys of the run, from the audit.json it ran from, or
 * from its prepared inputs when that copy is unreadable. */
const plannedUnitsOf = async (
  dir: string,
): Promise<
  { reportKey: string; keys: Set<string> | undefined } | undefined
> => {
  const auditCopy = path.join(dir, auditCopyFile);

  if (await exists(auditCopy)) {
    try {
      const file = await readAuditFile(auditCopy);
      // The capture plan alone: what a run measures, independent of the
      // model and budget it runs under.
      const plan = capturePlan(toAuditConfig(file), file.surfaces);

      return {
        reportKey: localReportKey(file),
        keys: new Set(plan.units.map(unitRecordKey)),
      };
    } catch {
      // An audit.json this engine no longer reads: fall back to the inputs.
    }
  }

  const inputs = await readRunInputs(dir).catch(() => undefined);

  if (!inputs) {
    return undefined;
  }

  // The prepared inputs carry the plan's size, not its keys.
  return { reportKey: inputs.reportKey, keys: undefined };
};

const readAnswers = async (dir: string): Promise<RunStatus['answers']> => {
  const planned = await plannedUnitsOf(dir);

  if (!planned) {
    return { planned: undefined, captured: 0, failed: 0 };
  }

  const bank = await FileProbeStore.open(planned.reportKey, {
    dir: path.join(dir, bankDir),
  });
  const records = (await bank.list()).filter(
    (record) =>
      planned.keys === undefined || planned.keys.has(unitRecordKey(record)),
  );
  const inputs =
    planned.keys === undefined
      ? await readRunInputs(dir).catch(() => undefined)
      : undefined;

  const answers = {
    planned: planned.keys?.size ?? inputs?.capture.plannedUnits,
    captured: records.filter((record) => record.status === 'captured').length,
    failed: records.filter((record) => record.status !== 'captured').length,
  };

  return answers;
};

/** readRunStatus reads a run directory's state; undefined when it holds no
 * run (no journal, no bank, no prepared inputs). */
export const readRunStatus = async (
  dir: string,
): Promise<RunStatus | undefined> => {
  const [events, directoryState, hasBank, hasJournal] = await Promise.all([
    readEvents(dir),
    runDirectoryState(dir),
    exists(path.join(dir, bankDir)),
    exists(path.join(dir, runJournalDir, 'events.jsonl')),
  ]);

  if (directoryState === 'new' && !hasBank && !hasJournal) {
    return undefined;
  }

  const lock = await readWriterLock(dir);
  const lastActivity = lastActivityOf(events);
  const end = endOf(events);
  const completedStages: string[] = [];

  for (const stage of workflowStages) {
    if (await exists(path.join(dir, 'OUT', `${stage}.json`))) {
      completedStages.push(stage);
    }
  }

  const lastError = lastErrorOf(events);
  let phase = lastActivity && phaseOf(lastActivity);

  if (directoryState === 'completed') {
    phase = 'completed';
  } else if (end?.type === 'run_failed') {
    phase = 'stopped';
  } else if (end?.type === 'run_interrupted') {
    phase = 'interrupted';
  }

  const status: RunStatus = {
    dir,
    // Answers already banked make the next run a resume, not a start.
    state: directoryState === 'new' ? 'resumable' : directoryState,
    writer: lock && {
      purpose: lock.owner.purpose,
      pid: lock.owner.pid,
      host: lock.owner.host,
      since: lock.owner.acquiredAt,
      state: lock.state,
    },
    phase,
    lastActivity,
    completedStages,
    answers: await readAnswers(dir),
    spend: await readSpend(dir),
    lastError,
    stoppedAtBudget:
      end?.type === 'run_failed' && end.payload.error === 'ModelBudgetError',
  };

  return status;
};
