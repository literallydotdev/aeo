import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditFileSchema } from '../engine/audit-file';
import { exampleAuditFile } from '../engine/templates';
import { parseFlags } from './io';
import { runPlan } from './run-commands';

// ============================================================================
// literally-aeo plan: what a run would measure and cost, and what it would
// spend outside its cap. Nothing here reaches the network or a CLI.
// ============================================================================

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-plan-command-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const flagsFor = async (audit: unknown) => {
  const config = path.join(root, 'audit.json');

  await writeFile(config, JSON.stringify(audit));

  return parseFlags(['--config', config, '--output', path.join(root, 'run')]);
};

describe('run-commands - runPlan()', () => {
  it('should say which coding agents bill a provider account outside the cap, and on which setting', async () => {
    const audit = auditFileSchema.parse({
      ...exampleAuditFile,
      surfaces: [
        ...exampleAuditFile.surfaces,
        'claude_code',
        'codex',
        'cursor',
      ],
    });
    const flags = await flagsFor(audit);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(await runPlan(flags)).toBe(0);

    const output = stdout.mock.calls.map(([text]) => String(text)).join('');

    expect(output).toContain(
      "on its own login, your plan; on ANTHROPIC_API_KEY, that Anthropic account, outside this run's cap",
    );
    expect(output).toContain(
      "on its own login, your plan; on OPENAI_API_KEY, that OpenAI account, outside this run's cap",
    );
    expect(output).not.toContain('cursor billing');
  });
});
