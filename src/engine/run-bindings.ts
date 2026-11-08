import { readFile } from 'node:fs/promises';
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
  const file = path.join(bankPath, bindingsFile);
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });

  if (text !== undefined) {
    let frozen: z.infer<typeof frozenBindingsSchema>;

    try {
      frozen = frozenBindingsSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new RunBindingsError(
        `${file} is not a frozen bindings file (${error instanceof Error ? error.message.slice(0, 200) : String(error)}). Please restore it; a run never re-chooses how it measures.`,
      );
    }

    return availableBindings(frozen.bindings);
  }

  const bindings = startedBefore ? legacyProbeBindings : defaultProbeBindings;

  await writeFileAtomically(
    file,
    `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`,
  );

  return bindings;
};
