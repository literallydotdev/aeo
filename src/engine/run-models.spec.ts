import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogError, type ModelCatalogSource } from '../models/catalog';
import { recommendedModelId } from '../models/supported-models';
import type { ExecutionRecorder } from '../bundle/recorder';
import {
  modelsFile,
  recordedCatalogSource,
  resolveReportModel,
  resolveRunModels,
} from './run-models';

let bank: string;

beforeEach(async () => {
  bank = await mkdtemp(path.join(tmpdir(), 'aeo-run-models-'));
});

afterEach(async () => {
  await rm(bank, { recursive: true, force: true });
});

const entry = (id: string, input: string) => {
  return {
    id,
    name: 'Acme Model',
    type: 'language',
    context_window: 200_000,
    max_tokens: 16_000,
    tags: ['reasoning'],
    reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
    pricing: { input, output: '0.000002' },
  };
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
const frozenFile = () => readFile(path.join(bank, modelsFile), 'utf8');

describe('run-models - resolveRunModels()', () => {
  it('should freeze a model at the price it had when the run first read it', async () => {
    const first = catalog(entry('acme/model', '0.000001'));
    const dearer = catalog(entry('acme/model', '0.000009'));

    const [frozen] = await resolveRunModels(bank, ['acme/model'], {
      source: first.source,
      now,
      freeze: true,
    });
    const [resumed] = await resolveRunModels(bank, ['acme/model'], {
      source: dearer.source,
      now: new Date('2026-12-01T00:00:00.000Z'),
      freeze: true,
    });

    expect(frozen?.model.pricingUsdPerMillion.input).toBe(1);
    expect(resumed).toEqual(frozen);
    // The resume read no catalog at all.
    expect(dearer.list).not.toHaveBeenCalled();
    expect(JSON.parse(await frozenFile())).toMatchObject({
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
      freeze: true,
    });
    const later = catalog(
      entry('acme/model', '0.000009'),
      entry('acme/other', '0.000003'),
    );

    const models = await resolveRunModels(bank, ['acme/other', 'acme/model'], {
      source: later.source,
      now,
      freeze: true,
    });

    expect(
      models.map(({ model }) => [model.id, model.pricingUsdPerMillion.input]),
    ).toEqual([
      ['acme/other', 3],
      ['acme/model', 1],
    ]);
    expect(later.list).toHaveBeenCalledTimes(1);
  });

  it('should price without writing anything for a read-only command', async () => {
    const { source } = catalog(entry('acme/model', '0.000001'));

    const [priced] = await resolveRunModels(bank, ['acme/model'], {
      source,
      now,
      freeze: false,
    });

    expect(priced?.model.pricingUsdPerMillion.input).toBe(1);
    await expect(frozenFile()).rejects.toThrow();
  });

  it('should read no catalog and write no file when no model is named', async () => {
    const { source, list } = catalog();

    expect(
      await resolveRunModels(bank, [], { source, now, freeze: true }),
    ).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    await expect(frozenFile()).rejects.toThrow();
  });

  it('should freeze nothing when a model cannot be priced', async () => {
    const { source } = catalog(entry('acme/model', '0.000001'));

    await expect(
      resolveRunModels(bank, ['acme/model', 'acme/unlisted'], {
        source,
        now,
        freeze: true,
      }),
    ).rejects.toBeInstanceOf(ModelCatalogError);
    await expect(frozenFile()).rejects.toThrow();
  });

  it('should refuse a damaged price file, never price the run again', async () => {
    const { source, list } = catalog(entry('acme/model', '0.000001'));

    await writeFile(path.join(bank, modelsFile), '{"version":1}\n');

    await expect(
      resolveRunModels(bank, ['acme/model'], { source, now, freeze: true }),
    ).rejects.toThrow(/models\.json is not a frozen model price file/);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('run-models - resolveReportModel()', () => {
  it("should use the engine's own entry without reading a catalog, named or not", async () => {
    const { source, list } = catalog();
    const options = { source, now, freeze: true };

    const unnamed = await resolveReportModel(undefined, bank, options);
    const named = await resolveReportModel(
      'anthropic/claude-sonnet-5.5',
      bank,
      options,
    );

    expect(unnamed.id).toBe(recommendedModelId);
    expect(named).toMatchObject({
      id: 'anthropic/claude-sonnet-5.5',
      stageRuntimeVerifiedAt: '2026-11-04',
    });
    expect(list).not.toHaveBeenCalled();
    await expect(frozenFile()).rejects.toThrow();
  });

  it('should run any other gateway model on its frozen catalog price and derived settings', async () => {
    const { source } = catalog(entry('acme/model', '0.000001'));

    const model = await resolveReportModel('acme/model', bank, {
      source,
      now,
      freeze: true,
    });

    expect(model).toEqual({
      id: 'acme/model',
      label: 'Acme Model',
      pricingUsdPerMillion: { input: 1, output: 2, cachedInput: 1 },
      pricingCheckedAt: '2026-11-10',
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
      thinkingInOutput: true,
      providerOptions: { gateway: { reasoning: { effort: 'high' } } },
      stageReasoningEffort: 'high',
      // Never run on the Codex stage runtime by the maintainers.
      stageRuntimeVerifiedAt: null,
    });
    expect(JSON.parse(await frozenFile())).toMatchObject({
      models: [{ model: { id: 'acme/model' } }],
    });
  });

  it('should refuse a model outside its own list when the command has no catalog', async () => {
    await expect(
      resolveReportModel('acme/model', bank, {
        source: undefined,
        now,
        freeze: true,
      }),
    ).rejects.toThrow(
      /acme\/model must be priced from the gateway's model list/,
    );
  });
});

describe('run-models - recordedCatalogSource()', () => {
  const journal = () => {
    const events: unknown[] = [];
    const recorder: ExecutionRecorder = {
      start: (operation) => {
        events.push({ started: operation });

        return Promise.resolve({
          id: 'operation-1',
          finish: (result) => {
            events.push({ finished: result });

            return Promise.resolve();
          },
        });
      },
      record: () => Promise.resolve(),
    };

    return { events, recorder };
  };

  it('should record a read of the catalog before it is made, with the size and digest of what came back', async () => {
    const { events, recorder } = journal();
    const list = vi.fn(() => {
      // Started before the request is made.
      expect(events).toHaveLength(1);

      return Promise.resolve('{"data":[]}');
    });
    const source = recordedCatalogSource(
      { origin: 'gateway', list, endpoints: () => Promise.resolve('{}') },
      recorder,
    );

    expect(await source.list()).toBe('{"data":[]}');
    expect(events).toEqual([
      {
        started: {
          kind: 'model_catalog',
          role: 'list',
          details: { origin: 'gateway' },
        },
      },
      {
        finished: {
          outcome: 'succeeded',
          details: {
            bytes: 11,
            sha256:
              '8fe32e407a1038ee38753b70e5374b3a46d6ae9d5f16cd5b73c53abaca8f5ed0',
          },
        },
      },
    ]);
  });

  it('should record a failed read as failed, and rethrow it', async () => {
    const { events, recorder } = journal();
    const source = recordedCatalogSource(
      {
        origin: 'gateway',
        list: () => Promise.reject(new Error('the gateway answered 503')),
        endpoints: () => Promise.resolve('{}'),
      },
      recorder,
    );

    await expect(source.list()).rejects.toThrow('the gateway answered 503');
    expect(events[1]).toMatchObject({ finished: { outcome: 'failed' } });
  });
});
