import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditFileSchema, localReportKey } from '../engine/audit-file';
import { budgetPolicySchema, resolveRunBudget } from '../engine/budget';
import { planLocalRun } from '../engine/local-run';
import { exampleAuditFile } from '../engine/templates';
import { resolveSupportedModel } from '../models/supported-models';
import { defaultProbeBindings } from '../probes/bindings';
import type { CapturedUnitRecord } from '../stores/ports';
import { parseFlags } from './io';
import { runRun } from './run-commands';

// Preflight launches Chromium for the money pages; here a fake that starts.
vi.mock('playwright', () => ({
  chromium: {
    launch: () =>
      Promise.resolve({
        version: () => '150.0.0.0',
        close: () => Promise.resolve(),
      }),
  },
}));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-run-command-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

const flagsFor = async (extra: readonly string[] = []) => {
  const config = path.join(root, 'audit.json');

  await writeFile(config, JSON.stringify(exampleAuditFile));
  await writeFile(path.join(root, 'empty.env'), '');

  return parseFlags([
    '--config',
    config,
    '--output',
    path.join(root, 'run'),
    '--env-file',
    path.join(root, 'empty.env'),
    ...extra,
  ]);
};

describe('run-commands - runRun()', () => {
  it('should refuse a run without an approved cap, print the estimate and spend nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const code = await runRun(await flagsFor());

    const message = stderr.mock.calls.map(([text]) => String(text)).join('');

    expect(code).toBe(2);
    expect(message).toContain('needs an approved spending cap');
    expect(message).toMatch(/Estimated cost: +\$\d+\.\d{2} to \$\d+\.\d{2}/);
    expect(message).toMatch(/--max-usd \d+/);
    await expect(readdir(root)).resolves.toEqual(['audit.json', 'empty.env']);
  });

  it("should stop with exit 2 before any dispatch when the run directory's frozen binding is not available", async () => {
    // Credentials come from the env file only, never the developer's shell.
    for (const name of [
      'AI_GATEWAY_API_KEY',
      'DATAFORSEO_LOGIN',
      'DATAFORSEO_PASSWORD',
    ]) {
      vi.stubEnv(name, undefined);
    }

    vi.stubEnv('AEO_CODEX_BIN', process.execPath);
    vi.stubEnv('PATH', path.join(root, 'no-agent-clis'));
    const fetch = vi.fn(() => Promise.reject(new Error('No network here.')));

    vi.stubGlobal('fetch', fetch);
    const flags = await flagsFor(['--max-usd', '5']);

    await writeFile(
      path.join(root, 'empty.env'),
      'AI_GATEWAY_API_KEY=fake-gateway-key\nDATAFORSEO_LOGIN=fake-login\nDATAFORSEO_PASSWORD=fake-password\n',
    );
    await mkdir(path.join(root, 'run', 'BANK'), { recursive: true });
    await writeFile(
      path.join(root, 'run', 'BANK', 'bindings.json'),
      JSON.stringify({
        version: 1,
        bindings: {
          ...defaultProbeBindings,
          chatgpt: { adapter: 'gateway.openai@9', model: 'openai/gpt-test-1' },
        },
      }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const code = await runRun(flags);

    const message = stderr.mock.calls.map(([text]) => String(text)).join('');

    expect(code).toBe(2);
    expect(message).toContain('chatgpt with gateway.openai@9');
    expect(fetch).not.toHaveBeenCalled();
    // Nothing was banked: the probe store was never written, only the
    // method and bindings the run froze.
    await expect(
      readdir(path.join(root, 'run', 'BANK')).then((files) => files.sort()),
    ).resolves.toEqual(['bindings.json', 'method.json']);
    // The bindings freeze before the budget: an attempt stopped between
    // the two never leaves a budget without bindings, which only a
    // directory from before bindings were frozen holds.
    await expect(readdir(path.join(root, 'run'))).resolves.not.toContain(
      'BUDGET.json',
    );
  });

  it('should stop with exit 1 before any dispatch when the run directory was started before 0.4.0', async () => {
    // Credentials come from the env file only, never the developer's shell.
    for (const name of [
      'AI_GATEWAY_API_KEY',
      'DATAFORSEO_LOGIN',
      'DATAFORSEO_PASSWORD',
    ]) {
      vi.stubEnv(name, undefined);
    }

    vi.stubEnv('AEO_CODEX_BIN', process.execPath);
    vi.stubEnv('PATH', path.join(root, 'no-agent-clis'));
    const fetch = vi.fn(() => Promise.reject(new Error('No network here.')));

    vi.stubGlobal('fetch', fetch);
    const flags = await flagsFor(['--max-usd', '5']);
    const runDir = path.join(root, 'run');

    await writeFile(
      path.join(root, 'empty.env'),
      'AI_GATEWAY_API_KEY=fake-gateway-key\nDATAFORSEO_LOGIN=fake-login\nDATAFORSEO_PASSWORD=fake-password\n',
    );

    // As 0.3.0 left it: a frozen budget and bindings, no frozen method.
    await resolveRunBudget(runDir, budgetPolicySchema.parse({}), {
      model: resolveSupportedModel(exampleAuditFile.model).id,
      maxUsd: 5,
    });
    await mkdir(path.join(runDir, 'BANK'), { recursive: true });
    await writeFile(
      path.join(runDir, 'BANK', 'bindings.json'),
      JSON.stringify({ version: 1, bindings: defaultProbeBindings }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const code = await runRun(flags);

    const message = stderr.mock.calls.map(([text]) => String(text)).join('');

    expect(message).toContain(`npx literally-aeo@0.3.0 run --output ${runDir}`);
    expect(code).toBe(1);
    expect(message).toContain(`literally-aeo rejudge ${runDir}`);
    expect(fetch).not.toHaveBeenCalled();
    await expect(readdir(path.join(runDir, 'BANK'))).resolves.toEqual([
      'bindings.json',
    ]);
  });

  it('should stop with exit 2 before the agent canaries when a banked answer was captured with another adapter', async () => {
    for (const name of [
      'AI_GATEWAY_API_KEY',
      'DATAFORSEO_LOGIN',
      'DATAFORSEO_PASSWORD',
      'OPENAI_API_KEY',
    ]) {
      vi.stubEnv(name, undefined);
    }

    // Codex "installed" as this Node: a canary that ran would start it and
    // fail the preflight (exit 1) before the bank was ever checked.
    vi.stubEnv('AEO_CODEX_BIN', process.execPath);
    vi.stubEnv('PATH', path.join(root, 'no-agent-clis'));
    const fetch = vi.fn(() => Promise.reject(new Error('No network here.')));

    vi.stubGlobal('fetch', fetch);
    const audit = auditFileSchema.parse({
      ...exampleAuditFile,
      surfaces: [...exampleAuditFile.surfaces, 'codex'],
    });
    const flags = await flagsFor(['--max-usd', '5']);

    await writeFile(path.join(root, 'audit.json'), JSON.stringify(audit));
    await writeFile(
      path.join(root, 'empty.env'),
      'AI_GATEWAY_API_KEY=fake-gateway-key\nDATAFORSEO_LOGIN=fake-login\nDATAFORSEO_PASSWORD=fake-password\nOPENAI_API_KEY=fake-openai-key\n',
    );

    const unit = planLocalRun(audit).plan.units.find(
      (planned) => planned.surface === 'chatgpt',
    );

    if (!unit) {
      throw new Error('The example audit plans no chatgpt unit.');
    }

    const banked: CapturedUnitRecord = {
      status: 'captured',
      ...unit,
      runId: 'run-1',
      capturedAt: '2026-11-01T10:00:00.000Z',
      probe: {
        promptId: unit.promptId,
        promptText: unit.promptText,
        promptCategory: 'comparison',
        modelName: unit.surface,
        runIndex: unit.runIndex,
        text: 'Acme Files.',
      },
      captureMetadata: {
        requestedModel: 'openai/gpt-5.4-mini',
        reportedModel: null,
        parameters: {},
        adapter: 'gateway.openai@2',
      },
    };

    await mkdir(path.join(root, 'run', 'BANK'), { recursive: true });
    await writeFile(
      path.join(root, 'run', 'BANK', `${localReportKey(audit)}.jsonl`),
      `${JSON.stringify(banked)}\n`,
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const code = await runRun(flags);

    const message = stderr.mock.calls.map(([text]) => String(text)).join('');

    expect(code).toBe(2);
    expect(message).toContain(
      'banked answers were captured with another adapter',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should refuse a --max-usd that is not an amount', async () => {
    const result = runRun(await flagsFor(['--max-usd', 'lots']));

    await expect(result).rejects.toThrow(/positive amount/);
  });
});
