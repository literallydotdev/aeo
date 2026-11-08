import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultProbeBindings, RunBindingsError } from '../probes/bindings';
import { legacyProbeBindings } from '../probes/legacy-bindings';
import { bindingsFile, resolveRunBindings } from './run-bindings';

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

  it('should keep the frozen bindings on a resume, never the defaults', async () => {
    const frozen = {
      ...defaultProbeBindings,
      chatgpt: { adapter: 'gateway.openai@1', model: 'openai/gpt-test-1' },
    };

    await frozenFile(frozen);

    await expect(
      resolveRunBindings(bank, { startedBefore: true }),
    ).resolves.toEqual(frozen);
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
  ])(
    'should refuse a frozen binding to %s, naming the binding it needs',
    async (_case, change, named) => {
      await frozenFile({ ...defaultProbeBindings, ...change });

      const resolved = resolveRunBindings(bank, { startedBefore: true });

      await expect(resolved).rejects.toBeInstanceOf(RunBindingsError);
      await expect(resolved).rejects.toThrow(named);
    },
  );

  it('should refuse a bindings file that is not one, rather than choose again', async () => {
    await mkdir(bank, { recursive: true });
    await writeFile(path.join(bank, bindingsFile), '{"version":2}');

    await expect(
      resolveRunBindings(bank, { startedBefore: true }),
    ).rejects.toBeInstanceOf(RunBindingsError);
  });
});
