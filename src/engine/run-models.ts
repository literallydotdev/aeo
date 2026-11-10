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
import { reportModelOf } from '../models/open-model';
import {
  findSupportedModel,
  resolveSupportedModel,
  type SupportedModel,
} from '../models/supported-models';
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
  source: ModelCatalogSource | undefined,
): Promise<CatalogModel[]> => {
  if (missing.length === 0) {
    return [];
  }

  if (!source) {
    throw new ModelCatalogError(
      `${missing.join(', ')} must be priced from the gateway's model list, and this command was given none to read.`,
    );
  }

  return readCatalogModels(missing, source);
};

/** One model's catalog entry as a run froze it. */
export type FrozenModel = FrozenModels['models'][number];

type ResolveOptions = {
  /** Absent when the command was given no catalog: a model that needs one
   * is then refused. */
  source: ModelCatalogSource | undefined;
  now: Date;
  /** False for a read-only command (a plan, an estimate, doctor): what the
   * catalog says now is used, and nothing is written. */
  freeze: boolean;
};

/**
 * resolveRunModels returns the price entry of each named model: the frozen
 * one when the run directory holds it, otherwise read from the catalog and,
 * for a run, frozen before it is used. The catalog is not read when every
 * model is already frozen, or when none is named.
 */
export const resolveRunModels = async (
  bankPath: string,
  ids: readonly string[],
  { source, now, freeze }: ResolveOptions,
): Promise<FrozenModel[]> => {
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
    origin: source?.origin ?? 'gateway',
    model,
  }));
  const models = [...frozen, ...added];

  if (freeze && added.length > 0) {
    await writeFileAtomically(
      path.join(bankPath, modelsFile),
      `${JSON.stringify({ version: 1, models } satisfies FrozenModels, null, 2)}\n`,
    );
  }

  return wanted.flatMap((id) => {
    const entry = models.find((candidate) => candidate.model.id === id);

    return entry ? [entry] : [];
  });
};

/**
 * resolveReportModel is the model a run judges and writes with: the
 * engine's own entry when it has one for `id` (or for the recommended model
 * when none is named), with no catalog read; otherwise the model's catalog
 * entry, with settings derived from it.
 */
export const resolveReportModel = async (
  id: string | undefined,
  bankPath: string,
  options: ResolveOptions,
): Promise<SupportedModel> => {
  if (id === undefined) {
    return resolveSupportedModel();
  }

  const own = findSupportedModel(id);

  if (own) {
    return own;
  }

  const [entry] = await resolveRunModels(bankPath, [id], options);

  if (!entry) {
    throw new ModelCatalogError(`${id} could not be priced.`);
  }

  return reportModelOf(entry.model, entry.readAt.slice(0, 10));
};
