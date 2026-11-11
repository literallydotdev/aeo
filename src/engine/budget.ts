import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from '../codex-workflow/pending';
import type { ModelBudgetLimits } from '../models/accounting';
import {
  reasoningEffortSchema,
  type ReasoningEffort,
} from '../models/profiles';
import { hasErrorCode } from '../stores/fs-errors';

// ============================================================================
// A local run's budget (specs/aeo-open-source-cli-spec.md §6,
// specs/aeo-claude-operator-spec.md §4.2): finite dollar, token and time
// allowances, frozen with the run and its model and kept across restarts.
// The dollar cap is the amount the operator approved: there is no default,
// and a run without one does not start. Editing audit.json never amends a
// run in progress; raising a limit is an explicit, recorded amendment. The
// ledger itself (reservations and settlements of every paid call) lives
// beside it in BANK/, so spending is never reset.
// ============================================================================

export const budgetFile = 'BUDGET.json';

const maxUsdSchema = z.number().finite().positive();

/** What audit.json says: the dollar cap is optional there, because the
 * operator may approve it on the command line instead. */
export const budgetPolicySchema = z
  .object({
    maxUsd: maxUsdSchema.optional(),
    // A backstop against a runaway loop; the dollar cap is the approval.
    maxTokens: z.number().int().positive().default(100_000_000),
    maxHours: z.number().finite().positive().max(72).default(12),
  })
  .strict();

export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;

/** The limits a run froze: the cap is always there. */
const frozenPolicySchema = budgetPolicySchema.extend({ maxUsd: maxUsdSchema });

export type FrozenBudgetPolicy = z.infer<typeof frozenPolicySchema>;

/** A --budget-file: the limits to raise; what it leaves out stays. */
export const budgetAmendmentSchema = frozenPolicySchema.partial().strict();

export type BudgetAmendment = z.infer<typeof budgetAmendmentSchema>;

const budgetStateSchema = z
  .object({
    version: z.literal(1),
    original: frozenPolicySchema,
    current: frozenPolicySchema,
    deadlineAt: z.iso.datetime(),
    /** The gateway model the run judges with, and writes with unless
     * `writeModel` names another, frozen with the budget. Absent on a
     * directory from before model selection: the first resume records the
     * model it continues with. */
    model: z.string().min(1).optional(),
    /** The effort audit.json names for that model, frozen with it. Absent
     * when the audit names none. */
    modelEffort: reasoningEffortSchema.optional(),
    /** The model audit.json names to write the report's narrative
     * (`writeModel`), frozen with the report model. Absent when the audit
     * names none: the report model writes. */
    writeModel: z.string().min(1).optional(),
    amendments: z.array(
      z
        .object({
          at: z.iso.datetime(),
          from: frozenPolicySchema,
          to: frozenPolicySchema,
          deadlineFrom: z.iso.datetime(),
          deadlineTo: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict();

type BudgetState = z.infer<typeof budgetStateSchema>;

export type RunBudget = {
  limits: ModelBudgetLimits;
  policy: FrozenBudgetPolicy;
  model: string;
  /** The amendment this invocation recorded, for the run journal. */
  amended: BudgetState['amendments'][number] | undefined;
  /** audit.json asks for other limits than the run froze: reported, never
   * applied (spec §6). */
  policyDiffers: boolean;
};

const hoursFrom = (now: Date, hours: number) => {
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
};

/** readBudgetAmendment reads a --budget-file. */
export const readBudgetAmendment = async (
  file: string,
): Promise<BudgetAmendment> => {
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    throw new Error(`Please check --budget-file: ${file} cannot be read.`, {
      cause: err,
    });
  });

  return budgetAmendmentSchema.parse(JSON.parse(text));
};

/** Thrown before any paid work when a new run has no approved cap. */
export class BudgetCapMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetCapMissingError';
  }
}

const effortPhrase = (effort: ReasoningEffort | undefined): string => {
  return effort === undefined ? "the engine's own effort" : `effort ${effort}`;
};

const writerPhrase = (writeModel: string | undefined): string => {
  return writeModel ?? 'its report model (no writeModel)';
};

/** Thrown before any paid work when audit.json names another model, effort
 * or writer than the run directory froze. */
export class RunModelChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunModelChangedError';
  }
}

/** readFrozenBudget reads a run directory's BUDGET.json; undefined when
 * the directory has not started. Read-only. */
export const readFrozenBudget = async (
  dir: string,
): Promise<BudgetState | undefined> => {
  const text = await readFile(path.join(dir, budgetFile), 'utf8').catch(
    (err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) {
        return undefined;
      }

      throw err;
    },
  );

  return text === undefined
    ? undefined
    : budgetStateSchema.parse(JSON.parse(text));
};

type ResolveRunBudgetOptions = {
  /** The gateway model audit.json resolves to. */
  model: string;
  /** The effort audit.json names for it, if any. */
  modelEffort?: ReasoningEffort;
  /** The model audit.json names to write the narrative, if any. */
  writeModel?: string;
  /** The cap approved on the command line (`--max-usd`). On a new run it
   * sets the cap; on a resume it raises it, recorded like a --budget-file. */
  maxUsd?: number;
  amendment?: BudgetAmendment;
  now?: () => Date;
};

/**
 * resolveRunBudget returns the limits and the model a run executes under:
 * frozen from audit.json (and --max-usd) on the first run, kept on every
 * resume, raised only by an amendment. A new run without a dollar cap is
 * refused, as is a resume whose audit.json names another model, effort or
 * writer. An amendment that lowers a limit is refused: the ledger may
 * already hold more than the lower limit.
 */
export const resolveRunBudget = async (
  dir: string,
  policy: BudgetPolicy,
  {
    model,
    modelEffort,
    writeModel,
    maxUsd,
    amendment,
    now = () => new Date(),
  }: ResolveRunBudgetOptions,
): Promise<RunBudget> => {
  const file = path.join(dir, budgetFile);
  const existing = await readFrozenBudget(dir);
  const at = now();

  if (
    existing?.model !== undefined &&
    existing.model === model &&
    existing.modelEffort !== modelEffort
  ) {
    throw new RunModelChangedError(
      `This run directory judges with ${model} at ${effortPhrase(existing.modelEffort)}; audit.json now asks for ${effortPhrase(modelEffort)}. A run never changes how its model is asked. To judge the same answers at another effort, rejudge them into a new directory: literally-aeo rejudge ${dir} --output <new-run-dir> --model ${model} --effort <level>`,
    );
  }

  if (existing?.model !== undefined && existing.model !== model) {
    throw new RunModelChangedError(
      `This run directory judges with ${existing.model}; audit.json now names ${model}. A run never changes its model. To judge the same answers with ${model}, use: literally-aeo rejudge ${dir} --output <new-dir> --model ${model}`,
    );
  }

  if (
    existing?.model !== undefined &&
    existing.model === model &&
    existing.writeModel !== writeModel
  ) {
    throw new RunModelChangedError(
      `This run directory writes its report with ${writerPhrase(existing.writeModel)}; audit.json now names ${writerPhrase(writeModel)}. A run never changes its models. To have another model write, rejudge the same answers into a new directory, where they are judged again: literally-aeo rejudge ${dir} --output <new-run-dir> --write-model <model>`,
    );
  }

  const cap = maxUsd ?? policy.maxUsd;

  const startState = (): BudgetState => {
    if (cap === undefined) {
      throw new BudgetCapMissingError(
        'No spending cap: approve one with --max-usd <amount> or runPolicy.budget.maxUsd in audit.json.',
      );
    }

    const frozen = { ...policy, maxUsd: cap };

    return {
      version: 1,
      original: frozen,
      current: frozen,
      deadlineAt: hoursFrom(at, policy.maxHours),
      model,
      ...(modelEffort !== undefined && { modelEffort }),
      ...(writeModel !== undefined && { writeModel }),
      amendments: [],
    };
  };

  let state: BudgetState = existing ?? startState();
  let amended: RunBudget['amended'];
  const modelAdopted = state.model === undefined;

  // A directory from before model selection adopts the effort and the
  // writer with the model it continues with.
  state = {
    ...state,
    model,
    ...(modelAdopted && modelEffort !== undefined && { modelEffort }),
    ...(modelAdopted && writeModel !== undefined && { writeModel }),
  };

  // On a resume --max-usd raises the cap like a --budget-file does.
  const change: BudgetAmendment = {
    ...amendment,
    ...(existing && maxUsd !== undefined && maxUsd !== existing.current.maxUsd
      ? { maxUsd }
      : {}),
  };

  if (Object.keys(change).length > 0) {
    const to = { ...state.current, ...change };

    if (
      to.maxUsd < state.current.maxUsd ||
      to.maxTokens < state.current.maxTokens
    ) {
      throw new Error(
        `A cap can only be raised; this run already allows $${state.current.maxUsd} and ${state.current.maxTokens} tokens.`,
      );
    }

    const deadlineTo =
      change.maxHours === undefined
        ? state.deadlineAt
        : hoursFrom(at, change.maxHours);

    amended = {
      at: at.toISOString(),
      from: state.current,
      to,
      deadlineFrom: state.deadlineAt,
      deadlineTo,
    };
    state = {
      ...state,
      current: to,
      deadlineAt: deadlineTo,
      amendments: [...state.amendments, amended],
    };
  }

  if (!existing || amended || modelAdopted) {
    await writeFileAtomically(file, JSON.stringify(state, null, 2));
  }

  const budget: RunBudget = {
    limits: {
      maxUsd: state.current.maxUsd,
      maxTokens: state.current.maxTokens,
      deadlineAt: state.deadlineAt,
    },
    policy: state.current,
    model,
    amended,
    // Only what audit.json itself asks for: a cap approved on the command
    // line is not audit.json's, and a recorded raise is not a difference.
    policyDiffers:
      policy.maxTokens !== state.original.maxTokens ||
      policy.maxHours !== state.original.maxHours ||
      (policy.maxUsd !== undefined && policy.maxUsd !== state.original.maxUsd),
  };

  return budget;
};
