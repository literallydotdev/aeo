import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalDigest } from '../bundle/json';
import { writeEnv } from '../lib/env';
import { readAuthorEvidence } from './author';
import {
  auditFileSchema,
  localReportKey,
  readAuditFile,
  toAuditConfig,
} from './audit-file';
import { readSettings } from './env-file';
import { resolveRunBudget } from './budget';
import {
  planLocalRun,
  runDirectoryState,
  usesGroundingSearch,
} from './local-run';
import { runPreflight } from './preflight';
import { exampleAuditFile } from './templates';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-engine-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exampleFile = auditFileSchema.parse(exampleAuditFile);

describe('audit-file - readAuditFile()', () => {
  it('should accept the init template and map it to an internal config', async () => {
    const file = path.join(root, 'audit.json');

    await writeFile(file, JSON.stringify(exampleAuditFile));
    const audit = await readAuditFile(file);
    const config = toAuditConfig(audit);

    expect(config.reportKey).toBe('local-northwind-example');
    expect(config.surfaces.codingAgents).toBe('skip');
    expect(config.sections[0]?.prompts).toHaveLength(2);
  });

  it('should name what is wrong in an invalid configuration', async () => {
    const file = path.join(root, 'audit.json');
    const invalid = {
      ...exampleAuditFile,
      reportKey: 'not-a-customer-field',
      sections: [...exampleAuditFile.sections, ...exampleAuditFile.sections],
    };

    await writeFile(file, JSON.stringify(invalid));
    const result = readAuditFile(file);

    await expect(result).rejects.toThrow(
      /reportKey|Section keys must be unique/,
    );
  });

  it('should refuse a section key that could become a path', () => {
    const result = auditFileSchema.safeParse({
      ...exampleAuditFile,
      sections: [{ ...exampleAuditFile.sections[0], key: '../escape' }],
    });

    expect(result.success).toBe(false);
  });
});

describe('local-run - planLocalRun()', () => {
  it('should plan the selected surfaces and keep the measurement digest stable', () => {
    const first = planLocalRun(exampleFile);
    const second = planLocalRun(exampleFile, 'another-run');

    expect(first.plan.surfaces).toEqual([
      'chatgpt',
      'gemini',
      'claude',
      'perplexity',
    ]);
    expect(first.plan.units).toHaveLength(16);
    expect(second.digests).toEqual(first.digests);
  });

  it('should measure coding agents only when audit.json selects one', () => {
    const result = planLocalRun({
      ...exampleFile,
      surfaces: ['chatgpt', 'codex'],
    });

    expect(result.config.surfaces.codingAgents).toBe('measure');
    expect(result.plan.agentSurfaces).toEqual(['codex']);
  });

  it('should NOT change the measurement digest when only the run policy changes', () => {
    const result = planLocalRun({
      ...exampleFile,
      runPolicy: { ...exampleFile.runPolicy, maxPlannedUnits: 50 },
    });

    expect(result.digests).toEqual(planLocalRun(exampleFile).digests);
  });

  it('should derive one report key per brand domain', () => {
    const result = localReportKey({
      ...exampleFile,
      brand: { ...exampleFile.brand, domain: 'https://www.Example.COM/' },
    });

    expect(result).toBe('local-example-com');
  });
});

describe('local-run - runDirectoryState()', () => {
  it('should tell a new, a resumable and a completed run directory apart', async () => {
    const dir = path.join(root, 'audit-run');

    const states = [await runDirectoryState(dir)];

    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'INPUTS.json'), '{}');
    states.push(await runDirectoryState(dir));
    await writeFile(path.join(dir, 'SCORECARD.json'), '{}');
    states.push(await runDirectoryState(dir));

    expect(states).toEqual(['new', 'resumable', 'completed']);
  });
});

describe('env-file - readSettings()', () => {
  afterEach(() => {
    writeEnv('AEO_TEST_SETTING', undefined);
  });

  it('should prefer the process environment and say where each setting came from', async () => {
    const file = path.join(root, '.env');

    await writeFile(
      file,
      'AEO_TEST_SETTING=from-file\nAEO_TEST_OTHER=file-only\n',
    );
    writeEnv('AEO_TEST_SETTING', 'from-environment');
    const settings = await readSettings(file);

    expect(settings.sourceOf('AEO_TEST_SETTING')).toBe('environment');
    expect(settings.sourceOf('AEO_TEST_OTHER')).toBe('env_file');
    expect(settings.values(['AEO_TEST_SETTING', 'AEO_TEST_OTHER'])).toEqual([
      'from-environment',
      'file-only',
    ]);
  });

  it('should refuse an env file that was named but does not exist', async () => {
    const result = readSettings(path.join(root, 'missing.env'));

    await expect(result).rejects.toThrow(/--env-file/);
  });
});

describe('preflight - runPreflight()', () => {
  it('should ask for the DataForSEO pair only when AI Overviews are measured', async () => {
    const envFile = path.join(root, 'empty.env');

    await writeFile(envFile, '');
    const settings = await readSettings(envFile);

    const chatOnly = await runPreflight({
      surfaces: ['chatgpt'],
      settings,
      dir: path.join(root, 'run'),
    });
    const withOverviews = await runPreflight({
      surfaces: ['chatgpt', 'google_ai_overview'],
      settings,
      dir: path.join(root, 'run'),
    });

    expect(chatOnly.map((check) => check.name)).not.toContain(
      'DATAFORSEO_LOGIN',
    );
    expect(withOverviews.map((check) => check.name)).toContain(
      'DATAFORSEO_PASSWORD',
    );
  });
});

describe('budget - resolveRunBudget()', () => {
  const policy = { maxUsd: 10, maxTokens: 1_000, maxHours: 2 };
  const at = (iso: string) => () => new Date(iso);

  it('should freeze the budget on the first run and keep it on a resume', async () => {
    const first = await resolveRunBudget(root, policy, {
      now: at('2026-11-03T10:00:00.000Z'),
    });
    const resumed = await resolveRunBudget(root, policy, {
      now: at('2026-11-03T15:00:00.000Z'),
    });

    expect(first.limits).toEqual({
      maxUsd: 10,
      maxTokens: 1_000,
      deadlineAt: '2026-11-03T12:00:00.000Z',
    });
    expect(resumed.limits).toEqual(first.limits);
  });

  it('should NOT amend a run when only audit.json changed, and say so', async () => {
    await resolveRunBudget(root, policy);

    const edited = await resolveRunBudget(root, { ...policy, maxUsd: 50 });

    expect(edited.limits.maxUsd).toBe(10);
    expect(edited.policyDiffers).toBe(true);
  });

  it('should raise limits through an amendment and record old and new values', async () => {
    await resolveRunBudget(root, policy, {
      now: at('2026-11-03T10:00:00.000Z'),
    });

    const amended = await resolveRunBudget(root, policy, {
      amendment: { maxUsd: 25, maxHours: 4 },
      now: at('2026-11-03T13:00:00.000Z'),
    });
    const state = JSON.parse(
      await readFile(path.join(root, 'BUDGET.json'), 'utf8'),
    ) as { amendments: unknown[] };

    expect(amended.limits).toEqual({
      maxUsd: 25,
      maxTokens: 1_000,
      deadlineAt: '2026-11-03T17:00:00.000Z',
    });
    expect(amended.amended?.from.maxUsd).toBe(10);
    expect(state.amendments).toHaveLength(1);
  });

  it('should refuse an amendment that lowers a limit', async () => {
    await resolveRunBudget(root, policy);

    const result = resolveRunBudget(root, policy, {
      amendment: { maxTokens: 10 },
    });

    await expect(result).rejects.toThrow(/only raise limits/);
  });
});

describe('audit-file - market', () => {
  it('should refuse a geography no search market maps to', () => {
    const result = auditFileSchema.safeParse({
      ...exampleAuditFile,
      geography: 'atlantis',
    });

    expect(result.success).toBe(false);
  });
});

describe('preflight - grounding search', () => {
  it('should ask for the DataForSEO pair when full grounding searches through it', async () => {
    const envFile = path.join(root, 'empty.env');

    await writeFile(envFile, '');
    const settings = await readSettings(envFile);
    const checks = await runPreflight({
      surfaces: ['chatgpt'],
      settings,
      dir: path.join(root, 'run'),
      groundingSearch: true,
    });

    expect(checks.find((check) => check.name === 'DATAFORSEO_LOGIN')?.ok).toBe(
      false,
    );
    expect(usesGroundingSearch(planLocalRun(exampleFile).request)).toBe(true);
  });
});

describe('author - readAuthorEvidence()', () => {
  const authored = async (
    edit: (file: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const proposal = { ...exampleFile };
    const { author: _author, runPolicy: _runPolicy, ...measured } = proposal;
    const reference = {
      runId: 'author-run-1',
      proposedDigest: canonicalDigest(measured),
      record: 'author-record.json',
    } as const;

    await writeFile(
      path.join(root, 'author-record.json'),
      JSON.stringify({
        version: 1,
        runId: reference.runId,
        brief: {},
        proposed: measured,
        notes: {},
        research: {},
      }),
    );

    const final = auditFileSchema.parse(
      edit({ ...exampleAuditFile, author: reference }),
    );

    return readAuthorEvidence(path.join(root, 'audit.json'), final);
  };

  it('should declare a hand-written config as such', async () => {
    const result = await readAuthorEvidence(
      path.join(root, 'audit.json'),
      exampleFile,
    );

    expect(result.kind).toBe('manual');
  });

  it('should report the diff from the proposal to the final configuration', async () => {
    const result = await authored((file) => ({
      ...file,
      productBrief: 'Edited by the operator.',
    }));

    expect(result.kind).toBe('authored');
    expect(result.kind === 'authored' && result.diff).toEqual([
      {
        path: '$.productBrief',
        from: exampleFile.productBrief,
        to: 'Edited by the operator.',
      },
    ]);
  });

  it('should treat a run policy change as no edit to the proposal', async () => {
    const result = await authored((file) => ({
      ...file,
      runPolicy: { maxPlannedUnits: 20 },
    }));

    expect(result.kind === 'authored' && result.unedited).toBe(true);
  });

  it('should say when the named record is missing', async () => {
    const final = auditFileSchema.parse({
      ...exampleAuditFile,
      author: {
        runId: 'gone',
        proposedDigest: 'a'.repeat(64),
        record: 'author-record.json',
      },
    });

    const result = await readAuthorEvidence(
      path.join(root, 'audit.json'),
      final,
    );

    expect(result.kind).toBe('record_missing');
  });
});
