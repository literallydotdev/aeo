import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from '../codex-workflow/pending';
import {
  catalogModelSchema,
  ModelCatalogError,
  readCatalogModels,
  type CatalogModel,
  type ModelCatalogSource,
} from '../models/catalog';
import { hasErrorCode } from '../stores/fs-errors';

// ============================================================================
// A run's frozen model prices (open models spec §3): the catalog entry of
// every model the run uses that the engine has no entry of its own for,
// written to BANK/models.json before the first paid call and read back on
// every resume, like the budget and the bindings. The estimate and the
// ledger price from this file, so a run is never re-priced halfway through.
// ============================================================================

export const modelsFile = 'models.json';

const frozenModelsSchema = z
  .object({
    version: z.literal(1),
    models: z
      .array(
        z
          .object({
            readAt: z.iso.datetime(),
            origin: z.enum(['gateway', 'file']),
            model: catalogModelSchema,
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

type FrozenModels = z.infer<typeof frozenModelsSchema>;

const readFrozenModels = async (
  bankPath: string,
): Promise<FrozenModels['models']> => {
  const file = path.join(bankPath, modelsFile);
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });

  if (text === undefined) {
    return [];
  }

  try {
    return frozenModelsSchema.parse(JSON.parse(text)).models;
  } catch (error) {
    throw new ModelCatalogError(
      `${file} is not a frozen model price file (${error instanceof Error ? error.message.slice(0, 200) : String(error)}). Please restore it; a run is never priced again halfway through.`,
    );
  }
};

const readMissing = async (
  missing: readonly string[],
  source: ModelCatalogSource,
): Promise<CatalogModel[]> => {
  return missing.length === 0 ? [] : readCatalogModels(missing, source);
};

/**
 * resolveRunModels returns the price entry of each named model: the frozen
 * one when the run directory holds it, otherwise read from the catalog and
 * frozen before it is used. The catalog is not read when every model is
 * already frozen, or when none is named.
 */
export const resolveRunModels = async (
  bankPath: string,
  ids: readonly string[],
  { source, now }: { source: ModelCatalogSource; now: Date },
): Promise<CatalogModel[]> => {
  const wanted = [...new Set(ids)];

  if (wanted.length === 0) {
    return [];
  }

  const frozen = await readFrozenModels(bankPath);
  const missing = wanted.filter(
    (id) => !frozen.some((entry) => entry.model.id === id),
  );
  const added = (await readMissing(missing, source)).map((model) => ({
    readAt: now.toISOString(),
    origin: source.origin,
    model,
  }));
  const models = [...frozen, ...added];

  if (added.length > 0) {
    await writeFileAtomically(
      path.join(bankPath, modelsFile),
      `${JSON.stringify({ version: 1, models } satisfies FrozenModels, null, 2)}\n`,
    );
  }

  return wanted.flatMap((id) => {
    const entry = models.find((candidate) => candidate.model.id === id);

    return entry ? [entry.model] : [];
  });
};
