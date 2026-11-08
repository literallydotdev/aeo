import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleAuditFile } from '../engine/templates';
import { defaultProbeBindings } from '../probes/bindings';
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
    // Nothing was banked: the probe store was never written.
    await expect(readdir(path.join(root, 'run', 'BANK'))).resolves.toEqual([
      'bindings.json',
    ]);
  });

  it('should refuse a --max-usd that is not an amount', async () => {
    const result = runRun(await flagsFor(['--max-usd', 'lots']));

    await expect(result).rejects.toThrow(/positive amount/);
  });
});
