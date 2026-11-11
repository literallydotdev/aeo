import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultProbeBindings,
  requestedBindingsOf,
  RunBindingsError,
} from '../probes/bindings';
import { legacyProbeBindings } from '../probes/legacy-bindings';
import {
  bindingsFile,
  carryFrozenBindings,
  resolveRunBindings,
} from './run-bindings';

// ============================================================================
// Freezing a run's bindings (probe adapters spec §4.5): a new run freezes
// the defaults, a run that started before bindings existed freezes the
// legacy ones, a resume keeps what it froze, and a binding the installed
// engine cannot build stops the run.
// ============================================================================

let bank: string;

beforeEach(async () => {
  bank = path.join(await mkdtemp(path.join(tmpdir(), 'aeo-bindings-')), 'BANK');
});

afterEach(async () => {
  await rm(path.dirname(bank), { recursive: true, force: true });
});

const frozenFile = async (bindings: Record<string, unknown>) => {
  await mkdir(bank, { recursive: true });
  await writeFile(
    path.join(bank, bindingsFile),
    JSON.stringify({ version: 1, bindings }),
  );
};

describe('run-bindings - resolveRunBindings()', () => {
  it('should freeze the default bindings in a new run directory', async () => {
    const bindings = await resolveRunBindings(bank, { startedBefore: false });

    expect(bindings).toEqual(defaultProbeBindings);
    expect(
      JSON.parse(await readFile(path.join(bank, bindingsFile), 'utf8')),
    ).toEqual({ version: 1, bindings: defaultProbeBindings });
  });

  it('should freeze the legacy bindings for a run directory that started before bindings were frozen', async () => {
    const bindings = await resolveRunBindings(bank, { startedBefore: true });

    expect(bindings).toEqual(legacyProbeBindings);
  });

  it('should read the frozen bindings back on a resume, never choosing again', async () => {
    await frozenFile(legacyProbeBindings);
    const written = await readFile(path.join(bank, bindingsFile), 'utf8');

    await expect(
      resolveRunBindings(bank, { startedBefore: false }),
    ).resolves.toEqual(legacyProbeBindings);
    expect(await readFile(path.join(bank, bindingsFile), 'utf8')).toBe(written);
  });

  it.each([
    [
      'an adapter version the engine does not have',
      {
        chatgpt: { adapter: 'gateway.openai@9', model: 'openai/gpt-5.4-mini' },
      },
      /chatgpt with gateway\.openai@9 with openai\/gpt-5\.4-mini/,
    ],
    [
      'a model API without its model',
      { gemini: { adapter: 'gateway.google@1' } },
      /gemini with gateway\.google@1/,
    ],
    [
      "another surface's coding-agent CLI",
      { codex: { adapter: 'cli.cursor@1' } },
      /codex with cli\.cursor@1/,
    ],
    [
      'a model behind a surface that asks none',
      {
        google_ai_overview: {
          adapter: 'dataforseo.ai_overview@1',
          model: 'google/gemini-test-1',
        },
      },
      /google_ai_overview with dataforseo\.ai_overview@1 with google\/gemini-test-1/,
    ],
    [
      'a model adapter behind a coding agent',
      { codex: { adapter: 'gateway.openai@1', model: 'openai/gpt-test-1' } },
      /codex with gateway\.openai@1/,
    ],
  ])(
    'should refuse a frozen binding to %s, naming the binding it needs',
    async (_case, change, named) => {
      await frozenFile({ ...defaultProbeBindings, ...change });

      const resolved = resolveRunBindings(bank, { startedBefore: true });

      await expect(resolved).rejects.toBeInstanceOf(RunBindingsError);
      await expect(resolved).rejects.toThrow(named);
    },
  );

  it("should keep a frozen binding to any model, behind its own or another provider's adapter", async () => {
    const swapped = {
      ...defaultProbeBindings,
      chatgpt: { adapter: 'gateway.openai@1', model: 'openai/gpt-test-1' },
      perplexity: {
        adapter: 'gateway.google@1',
        model: 'google/gemini-test-1',
      },
    };

    await frozenFile(swapped);

    expect(await resolveRunBindings(bank, { startedBefore: true })).toEqual(
      swapped,
    );
  });

  it("should freeze audit.json's model overrides in a new run directory, and keep them on a resume", async () => {
    const requested = {
      bindings: requestedBindingsOf({
        chatgpt: { model: 'openai/gpt-test-1' },
        claude: { model: 'openai/gpt-test-2', adapter: 'gateway.openai@1' },
      }),
      overridden: ['chatgpt', 'claude'] as const,
    };

    const first = await resolveRunBindings(bank, {
      startedBefore: false,
      requested,
    });
    const resumed = await resolveRunBindings(bank, {
      startedBefore: true,
      requested,
    });

    expect(first).toEqual({
      ...defaultProbeBindings,
      // An OpenAI model is asked through its provider's current adapter.
      chatgpt: { adapter: 'gateway.openai@2', model: 'openai/gpt-test-1' },
      // The adapter audit.json names wins over the model's own provider:
      // the released version stays one an audit can name.
      claude: { adapter: 'gateway.openai@1', model: 'openai/gpt-test-2' },
    });
    expect(resumed).toEqual(first);
  });

  it('should refuse a resume whose audit.json names another model than the run froze, and leave an unnamed surface alone', async () => {
    await resolveRunBindings(bank, {
      startedBefore: false,
      requested: {
        bindings: requestedBindingsOf({
          chatgpt: { model: 'openai/gpt-test-1' },
        }),
        overridden: ['chatgpt'],
      },
    });

    await expect(
      resolveRunBindings(bank, {
        startedBefore: true,
        requested: {
          bindings: requestedBindingsOf({
            chatgpt: { model: 'openai/gpt-test-2' },
          }),
          overridden: ['chatgpt'],
        },
      }),
    ).rejects.toThrow(
      /measures chatgpt with openai\/gpt-test-1; audit\.json now asks for openai\/gpt-test-2/,
    );

    // The file no longer names a model: the run keeps the one it froze.
    const unnamed = await resolveRunBindings(bank, { startedBefore: true });

    expect(unnamed.chatgpt.model).toBe('openai/gpt-test-1');
  });

  it("should search through the gateway's own tool for a model of another provider, and for every custom surface", () => {
    const bindings = requestedBindingsOf(
      { chatgpt: { model: 'acme/model-1' } },
      [
        { key: 'grok', model: 'acme/model-2' },
        {
          key: 'native',
          model: 'openai/gpt-test-1',
          adapter: 'gateway.openai@1',
        },
      ],
    );

    expect(bindings.chatgpt).toEqual({
      adapter: 'gateway.search@1',
      model: 'acme/model-1',
    });
    expect(bindings['custom:grok']).toEqual({
      adapter: 'gateway.search@1',
      model: 'acme/model-2',
    });
    expect(bindings['custom:native']).toEqual({
      adapter: 'gateway.openai@1',
      model: 'openai/gpt-test-1',
    });
  });

  it('should keep a declared custom surface on a resume, and refuse one the run did not start with', async () => {
    const declared = (keys: readonly string[]) => {
      return {
        bindings: requestedBindingsOf(
          {},
          keys.map((key) => ({ key, model: `acme/${key}` })),
        ),
        overridden: keys.map((key) => `custom:${key}` as const),
      };
    };

    await resolveRunBindings(bank, {
      startedBefore: false,
      requested: declared(['grok']),
    });

    const resumed = await resolveRunBindings(bank, {
      startedBefore: true,
      requested: declared(['grok']),
    });
    const widened = resolveRunBindings(bank, {
      startedBefore: true,
      requested: declared(['grok', 'other']),
    });

    expect(resumed['custom:grok']).toEqual({
      adapter: 'gateway.search@1',
      model: 'acme/grok',
    });
    await expect(widened).rejects.toThrow(
      /audit\.json now declares custom:other, which this run directory did not start with/,
    );
  });

  it('should refuse a bindings file that is not one, rather than choose again', async () => {
    await mkdir(bank, { recursive: true });
    await writeFile(path.join(bank, bindingsFile), '{"version":2}');

    await expect(
      resolveRunBindings(bank, { startedBefore: true }),
    ).rejects.toBeInstanceOf(RunBindingsError);
  });
});

describe('run-bindings - carryFrozenBindings()', () => {
  it("should give a rejudgment the source run's frozen bindings, byte for byte", async () => {
    const target = path.join(path.dirname(bank), 'target', 'BANK');

    await frozenFile(legacyProbeBindings);
    await mkdir(target, { recursive: true });

    await carryFrozenBindings(bank, target);

    expect(await readFile(path.join(target, bindingsFile), 'utf8')).toBe(
      await readFile(path.join(bank, bindingsFile), 'utf8'),
    );
  });

  it('should freeze the legacy bindings for a source run from before bindings were frozen, never the defaults', async () => {
    const target = path.join(path.dirname(bank), 'target', 'BANK');

    await mkdir(bank, { recursive: true });
    await mkdir(target, { recursive: true });

    await carryFrozenBindings(bank, target);

    expect(
      JSON.parse(await readFile(path.join(target, bindingsFile), 'utf8')),
    ).toEqual({ version: 1, bindings: legacyProbeBindings });
  });
});
