import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from '../codex-workflow/pending';
import {
  availableBindings,
  defaultProbeBindings,
  RunBindingsError,
  type RunBindings,
} from '../probes/bindings';
import { legacyProbeBindings } from '../probes/legacy-bindings';
import { hasErrorCode } from '../stores/fs-errors';

// ============================================================================
// A run's frozen bindings (specs/aeo-probe-adapters-spec.md §4.5): written
// to BANK/bindings.json before the first canary and read back on every
// resume, like the budget's cap and model. A directory from before this
// file existed is frozen with the legacy bindings, the ones its banked
// answers were captured with.
// ============================================================================

export const bindingsFile = 'bindings.json';

const frozenBindingsSchema = z
  .object({
    version: z.literal(1),
    bindings: z.record(
      z.string(),
      z
        .object({
          adapter: z.string().min(1),
          model: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();

/** A run's frozen bindings as its file records them, adapter IDs unchecked. */
export type FrozenBindings = z.infer<typeof frozenBindingsSchema>['bindings'];

/**
 * readFrozenBindings returns the bindings a run directory froze, or
 * undefined when it froze none: a directory no engine since 0.3.0 has run.
 * A file that is not a frozen bindings file is refused, never guessed.
 */
export const readFrozenBindings = async (
  bankPath: string,
): Promise<FrozenBindings | undefined> => {
  const file = path.join(bankPath, bindingsFile);
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });

  if (text === undefined) {
    return undefined;
  }

  try {
    return frozenBindingsSchema.parse(JSON.parse(text)).bindings;
  } catch (error) {
    throw new RunBindingsError(
      `${file} is not a frozen bindings file (${error instanceof Error ? error.message.slice(0, 200) : String(error)}). Please restore it; a run never re-chooses how it measures.`,
    );
  }
};

/**
 * estimateBindingsOf is the bindings a run directory's estimate prices: its
 * frozen bindings once it has usable ones, else the defaults a new run
 * would freeze. Read-only. A frozen binding the engine cannot build is the
 * run's start to refuse (exit 2), not the estimate's.
 */
export const estimateBindingsOf = async (
  bankPath: string,
): Promise<RunBindings> => {
  try {
    const frozen = await readFrozenBindings(bankPath);

    return frozen === undefined
      ? defaultProbeBindings
      : availableBindings(frozen);
  } catch (error) {
    // Refused with its reason when the run starts.
    if (error instanceof RunBindingsError) {
      return defaultProbeBindings;
    }

    throw error;
  }
};

/**
 * resolveRunBindings returns the bindings a run measures with: the frozen
 * ones on a resume, refused when the installed engine cannot build them;
 * otherwise the defaults for a new run, or the legacy bindings for a run
 * that started before bindings were frozen, written before they are used.
 */
export const resolveRunBindings = async (
  bankPath: string,
  { startedBefore }: { startedBefore: boolean },
): Promise<RunBindings> => {
  const frozen = await readFrozenBindings(bankPath);

  if (frozen !== undefined) {
    return availableBindings(frozen);
  }

  const bindings = startedBefore ? legacyProbeBindings : defaultProbeBindings;

  await freezeBindings(bankPath, bindings);

  return bindings;
};

/**
 * carryFrozenBindings gives a derived run directory (a rejudgment) the
 * bindings its reused answers were captured under: the source's frozen
 * file, or, from before bindings were frozen, the legacy bindings. Never
 * the installed defaults.
 */
export const carryFrozenBindings = async (
  sourceBank: string,
  targetBank: string,
): Promise<void> => {
  await copyFile(
    path.join(sourceBank, bindingsFile),
    path.join(targetBank, bindingsFile),
  ).catch(async (err: unknown) => {
    if (!hasErrorCode(err, 'ENOENT')) {
      throw err;
    }

    await freezeBindings(targetBank, legacyProbeBindings);
  });
};

const freezeBindings = async (
  bankPath: string,
  bindings: RunBindings,
): Promise<void> => {
  await writeFileAtomically(
    path.join(bankPath, bindingsFile),
    `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`,
  );
};
