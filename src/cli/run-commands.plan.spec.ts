import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditFileSchema } from '../engine/audit-file';
import { exampleAuditFile } from '../engine/templates';
import { ModelCatalogError } from '../models/catalog';
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
  vi.unstubAllEnvs();
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

  describe('with a report model the engine has no entry of its own for', () => {
    // A saved copy of the gateway's model list: no network is reached.
    const savedCatalog = path.join(
      import.meta.dirname,
      '..',
      'models',
      '__fixtures__',
      'gateway-models.json',
    );

    it('should plan and estimate with any listed gateway model, priced from the catalog, and write nothing', async () => {
      vi.stubEnv('AEO_MODEL_CATALOG', savedCatalog);
      const flags = await flagsFor(
        auditFileSchema.parse({
          ...exampleAuditFile,
          model: 'anthropic/claude-sonnet-5',
        }),
      );
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      expect(await runPlan(flags)).toBe(0);

      const output = stdout.mock.calls.map(([text]) => String(text)).join('');

      expect(output).toContain('anthropic/claude-sonnet-5');
      // A plan is read-only: the run directory is not even created.
      await expect(access(path.join(root, 'run'))).rejects.toThrow();
    });

    it('should name the model an audit has write the narrative, price its request, and refuse one the catalog does not list', async () => {
      vi.stubEnv('AEO_MODEL_CATALOG', savedCatalog);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const withWriter = (writeModel: string) => {
        return flagsFor(
          auditFileSchema.parse({ ...exampleAuditFile, writeModel }),
        );
      };

      await expect(runPlan(await withWriter('acme/unlisted'))).rejects.toThrow(
        /acme\/unlisted is not on the gateway's model list/,
      );
      expect(await runPlan(await withWriter('anthropic/claude-sonnet-5'))).toBe(
        0,
      );

      const output = stdout.mock.calls.map(([text]) => String(text)).join('');

      expect(output).toMatch(
        /Writer:\s+anthropic\/claude-sonnet-5 \(the narrative, one request\)/,
      );
      expect(output).toContain(
        'anthropic/claude-opus-5.5, the narrative by anthropic/claude-sonnet-5)',
      );
    });

    it('should refuse a model the catalog does not list, before anything else', async () => {
      vi.stubEnv('AEO_MODEL_CATALOG', savedCatalog);
      const flags = await flagsFor(
        auditFileSchema.parse({ ...exampleAuditFile, model: 'acme/unlisted' }),
      );

      await expect(runPlan(flags)).rejects.toBeInstanceOf(ModelCatalogError);
      await expect(runPlan(flags)).rejects.toThrow(
        /acme\/unlisted is not on the gateway's model list/,
      );
    });
  });
});
