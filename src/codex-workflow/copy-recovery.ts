import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { VerifierFailureOutcome } from '../agents/copy-validation';
import type { ModelBudgetLimits } from '../models/accounting';
import { writePendingJson } from './pending';
import { maxReviewRounds } from './quality';

const legacyRefusal = z.object({
  attempt: z.number().int(),
  errors: z.array(z.string()),
});
const operationalErrors = (errors: readonly string[]) => {
  return (
    errors.length > 0 &&
    errors.every((error) =>
      /\((?:premise_verifier_invalid|premise_verifier_unavailable|model_budget_exhausted|cancelled|integrity_error)\)$/.test(
        error,
      ),
    )
  );
};

/** Old checkpoints counted unavailable checks as reviews. Subtract only
 * failures the evidence proves: the pending draft's own errors, then every
 * operational entry in the unbroken chain of journal attempts counting down
 * from the pending round. Genuine refusals in that chain keep their round;
 * the chain ends at the first gap, and nothing earlier is credited. */
export const recoverEditorialRounds = (
  pending: { rounds: number; errors: string[] },
  journal: string,
) => {
  let operational = operationalErrors(pending.errors) ? 1 : 0;
  let expected = pending.rounds - 1;
  const entries = journal
    .trim()
    .split('\n')
    .slice(-maxReviewRounds)
    .flatMap((line) => {
      try {
        const parsed = legacyRefusal.safeParse(JSON.parse(line));

        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });

  for (const entry of entries.reverse()) {
    if (entry.attempt === pending.rounds) {
      continue;
    }

    if (entry.attempt !== expected || expected < 1) {
      break;
    }

    if (operationalErrors(entry.errors)) {
      operational += 1;
    }

    expected -= 1;
  }

  return {
    rounds: Math.max(0, pending.rounds - operational),
    errors: operationalErrors(pending.errors) ? [] : pending.errors,
  };
};

/** An unavailable review says nothing about the quality of the saved draft. */
export class CopyVerificationUnavailableError extends Error {
  readonly outcome: VerifierFailureOutcome;
  readonly errors: readonly string[];

  constructor(outcome: VerifierFailureOutcome, errors: readonly string[]) {
    super(`Copy verification unavailable (${outcome}): ${errors.join('; ')}`);
    this.name = 'CopyVerificationUnavailableError';
    this.outcome = outcome;
    this.errors = errors;
  }
}

const windowSchema = z
  .object({
    passId: z.string(),
    startedAt: z.iso.datetime(),
    deadlineAt: z.iso.datetime(),
  })
  .strict();

/** Copy gets the admitted time allowance from its own start. Replacements
 * retain that window; all calls still charge the existing pipeline ledger. */
export const copyPassBudget = async (args: {
  dir: string;
  passId: string;
  admittedAt: string;
  limits: ModelBudgetLimits;
  checkpoint: (files: readonly string[]) => Promise<void>;
  now?: number;
}): Promise<ModelBudgetLimits> => {
  const file = 'PENDING/copy-budget.json';
  const target = path.join(args.dir, file);
  const saved = await readFile(target, 'utf8').catch(() => null);
  let window = saved ? windowSchema.parse(JSON.parse(saved)) : null;
  const duration =
    Date.parse(args.limits.deadlineAt) - Date.parse(args.admittedAt);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Copy pass has no valid admitted time allowance.');
  }

  if (window?.passId !== args.passId) {
    const now = args.now ?? Date.now();

    window = {
      passId: args.passId,
      startedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + duration).toISOString(),
    };
    await writePendingJson(target, window);
  }

  if (
    Date.parse(window.deadlineAt) - Date.parse(window.startedAt) !==
    duration
  ) {
    throw new Error('Saved copy time allowance does not match its admission.');
  }

  await args.checkpoint([file]);

  return { ...args.limits, deadlineAt: window.deadlineAt };
};
