import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogError, type ModelCatalogSource } from '../models/catalog';
import { modelsFile, resolveRunModels } from './run-models';

let bank: string;

beforeEach(async () => {
  bank = await mkdtemp(path.join(tmpdir(), 'aeo-run-models-'));
});

afterEach(async () => {
  await rm(bank, { recursive: true, force: true });
});

const entry = (id: string, input: string) => {
  return { id, type: 'language', pricing: { input, output: '0.000002' } };
};

/** A catalog whose list holds the given entries, counting its reads. */
const catalog = (...entries: unknown[]) => {
  const list = vi.fn(() => Promise.resolve(JSON.stringify({ data: entries })));
  const source: ModelCatalogSource = {
    origin: 'gateway',
    list,
    endpoints: () => Promise.reject(new Error('No endpoints were expected.')),
  };

  return { source, list };
};

const now = new Date('2026-11-10T12:00:00.000Z');

describe('run-models - resolveRunModels()', () => {
  it('should freeze a model at the price it had when the run first read it', async () => {
    const first = catalog(entry('acme/model', '0.000001'));
    const dearer = catalog(entry('acme/model', '0.000009'));

    const [frozen] = await resolveRunModels(bank, ['acme/model'], {
      source: first.source,
      now,
    });
    const [resumed] = await resolveRunModels(bank, ['acme/model'], {
      source: dearer.source,
      now: new Date('2026-12-01T00:00:00.000Z'),
    });

    expect(frozen?.pricingUsdPerMillion.input).toBe(1);
    expect(resumed).toEqual(frozen);
    // The resume read no catalog at all.
    expect(dearer.list).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(path.join(bank, modelsFile), 'utf8')),
    ).toMatchObject({
      version: 1,
      models: [
        {
          readAt: '2026-11-10T12:00:00.000Z',
          origin: 'gateway',
          model: { id: 'acme/model' },
        },
      ],
    });
  });

  it('should read only a model the run has not frozen yet, and keep the ones it has', async () => {
    await resolveRunModels(bank, ['acme/model'], {
      source: catalog(entry('acme/model', '0.000001')).source,
      now,
    });
    const later = catalog(
      entry('acme/model', '0.000009'),
      entry('acme/other', '0.000003'),
    );

    const models = await resolveRunModels(bank, ['acme/other', 'acme/model'], {
      source: later.source,
      now,
    });

    expect(
      models.map((model) => [model.id, model.pricingUsdPerMillion.input]),
    ).toEqual([
      ['acme/other', 3],
      ['acme/model', 1],
    ]);
    expect(later.list).toHaveBeenCalledTimes(1);
  });

  it('should read no catalog and write no file when no model is named', async () => {
    const { source, list } = catalog();

    expect(await resolveRunModels(bank, [], { source, now })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    await expect(readFile(path.join(bank, modelsFile))).rejects.toThrow();
  });

  it('should freeze nothing when a model cannot be priced', async () => {
    const { source } = catalog(entry('acme/model', '0.000001'));

    await expect(
      resolveRunModels(bank, ['acme/model', 'acme/unlisted'], { source, now }),
    ).rejects.toBeInstanceOf(ModelCatalogError);
    await expect(readFile(path.join(bank, modelsFile))).rejects.toThrow();
  });

  it('should refuse a damaged price file, never price the run again', async () => {
    const { source, list } = catalog(entry('acme/model', '0.000001'));

    await writeFile(path.join(bank, modelsFile), '{"version":1}\n');

    await expect(
      resolveRunModels(bank, ['acme/model'], { source, now }),
    ).rejects.toThrow(/models\.json is not a frozen model price file/);
    expect(list).not.toHaveBeenCalled();
  });
});
