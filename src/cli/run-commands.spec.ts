import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleAuditFile } from '../engine/templates';
import { parseFlags } from './io';
import { runRun } from './run-commands';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-run-command-'));
});

afterEach(async () => {
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

  it('should refuse a --max-usd that is not an amount', async () => {
    const result = runRun(await flagsFor(['--max-usd', 'lots']));

    await expect(result).rejects.toThrow(/positive amount/);
  });
});
