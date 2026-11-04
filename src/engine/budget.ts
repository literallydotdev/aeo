import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from '../codex-workflow/pending';
import type { ModelBudgetLimits } from '../models/accounting';
import { hasErrorCode } from '../stores/fs-errors';

// ============================================================================
// A local run's budget (specs/aeo-open-source-cli-spec.md §6): finite dollar,
// token and time allowances, frozen with the run and kept across restarts.
// Editing audit.json never amends a run in progress; raising a limit is an
// explicit, recorded `run --budget-file`. The ledger itself (reservations
// and settlements) lives beside it in BANK/, so spending is never reset.
// ============================================================================

export const budgetFile = 'BUDGET.json';

export const budgetPolicySchema = z
  .object({
    maxUsd: z.number().finite().positive().default(10),
    maxTokens: z.number().int().positive().default(5_000_000),
    maxHours: z.number().finite().positive().max(72).default(6),
  })
  .strict();

export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;

/** A --budget-file: the limits to raise; what it leaves out stays. */
export const budgetAmendmentSchema = budgetPolicySchema.partial().strict();

export type BudgetAmendment = z.infer<typeof budgetAmendmentSchema>;

const budgetStateSchema = z
  .object({
    version: z.literal(1),
    original: budgetPolicySchema,
    current: budgetPolicySchema,
    deadlineAt: z.iso.datetime(),
    amendments: z.array(
      z
        .object({
          at: z.iso.datetime(),
          from: budgetPolicySchema,
          to: budgetPolicySchema,
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
  policy: BudgetPolicy;
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

/**
 * resolveRunBudget returns the limits a run executes under: frozen from
 * audit.json on the first run, kept on every resume, raised only by an
 * amendment. An amendment that lowers a limit is refused: the ledger may
 * already hold more than the lower limit.
 */
export const resolveRunBudget = async (
  dir: string,
  policy: BudgetPolicy,
  {
    amendment,
    now = () => new Date(),
  }: { amendment?: BudgetAmendment; now?: () => Date } = {},
): Promise<RunBudget> => {
  const file = path.join(dir, budgetFile);
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });
  const existing =
    text === undefined ? undefined : budgetStateSchema.parse(JSON.parse(text));
  const at = now();
  let state: BudgetState = existing ?? {
    version: 1,
    original: policy,
    current: policy,
    deadlineAt: hoursFrom(at, policy.maxHours),
    amendments: [],
  };
  let amended: RunBudget['amended'];

  if (amendment && Object.keys(amendment).length > 0) {
    const to = { ...state.current, ...amendment };

    if (
      to.maxUsd < state.current.maxUsd ||
      to.maxTokens < state.current.maxTokens
    ) {
      throw new Error(
        `A --budget-file can only raise limits; this run already allows $${state.current.maxUsd} and ${state.current.maxTokens} tokens.`,
      );
    }

    const deadlineTo =
      amendment.maxHours === undefined
        ? state.deadlineAt
        : hoursFrom(at, amendment.maxHours);

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

  if (!existing || amended) {
    await writeFileAtomically(file, JSON.stringify(state, null, 2));
  }

  const budget: RunBudget = {
    limits: {
      maxUsd: state.current.maxUsd,
      maxTokens: state.current.maxTokens,
      deadlineAt: state.deadlineAt,
    },
    policy: state.current,
    amended,
    policyDiffers: JSON.stringify(policy) !== JSON.stringify(state.original),
  };

  return budget;
};
