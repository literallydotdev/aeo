import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalDigest } from '../bundle/json';
import { requireDefined } from '../__fixtures__/require-defined';
import { writeEnv } from '../lib/env';
import { defaultProbeBindings } from '../probes/bindings';
import { readAuthorEvidence } from './author';
import {
  auditFileSchema,
  localReportKey,
  readAuditFile,
  toAuditConfig,
  requestedBindings,
} from './audit-file';
import { readSettings } from './env-file';
import {
  BudgetCapMissingError,
  readFrozenBudget,
  resolveRunBudget,
  RunModelChangedError,
} from './budget';
import {
  planLocalRun,
  runDirectoryState,
  usesGroundingSearch,
} from './local-run';
import { agentAuthMode, runPreflight } from './preflight';
import { auditCopyFile, recordRunConfiguration } from './run-configuration';
import { exampleAuditFile } from './templates';

const browser = vi.hoisted(() => ({ installed: true }));

// The Chromium preflight launches the browser; here a fake one that is or is
// not installed.
vi.mock('playwright', () => ({
  chromium: {
    launch: () =>
      browser.installed
        ? Promise.resolve({
            version: () => '150.0.0.0',
            close: () => Promise.resolve(),
          })
        : Promise.reject(
            new Error("browserType.launch: Executable doesn't exist at /x"),
          ),
  },
}));

// A stand-in for the agent CLIs (hardening spec §6.2).
const fakeCliPath = path.join(
  import.meta.dirname,
  '..',
  'probes',
  '__fixtures__',
  'fake-cli',
  'fake-cli.mjs',
);

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

  it('should keep the measurement and plan digests when only the model behind a surface changes', () => {
    const swapped = auditFileSchema.parse({
      ...exampleAuditFile,
      probes: { chatgpt: { model: 'openai/gpt-test-1' } },
    });

    // A model is how a surface is asked, not what is measured.
    expect(planLocalRun(swapped).digests).toEqual(
      planLocalRun(exampleFile).digests,
    );
    expect(requestedBindings(swapped)).toEqual({
      bindings: {
        ...defaultProbeBindings,
        chatgpt: { adapter: 'gateway.openai@1', model: 'openai/gpt-test-1' },
      },
      overridden: ['chatgpt'],
    });
    expect(requestedBindings(exampleFile)).toEqual({
      bindings: defaultProbeBindings,
      overridden: [],
    });
  });

  it('should refuse a model behind a surface that asks none, and an unknown adapter', () => {
    const parse = (probes: unknown) => {
      return auditFileSchema.safeParse({ ...exampleAuditFile, probes });
    };

    expect(parse({ google_ai_overview: { model: 'google/x' } }).success).toBe(
      false,
    );
    expect(parse({ codex: { model: 'gpt-test-1' } }).success).toBe(false);
    expect(
      parse({ chatgpt: { model: 'openai/x', adapter: 'cli.codex@1' } }).success,
    ).toBe(false);
    expect(parse({ chatgpt: { model: 'openai/x' } }).success).toBe(true);
  });

  it('should plan every chat surface at the configured chat depth, as a new measurement', () => {
    const deeper = planLocalRun({
      ...exampleFile,
      chatProbes: { runsPerPrompt: 5 },
    });

    const standard = planLocalRun(exampleFile);

    // 2 prompts × 4 chat surfaces × 5 runs.
    expect(deeper.plan.units).toHaveLength(40);
    expect(deeper.digests.measurement).not.toBe(standard.digests.measurement);
    expect(deeper.digests.plan).not.toBe(standard.digests.plan);
  });

  it('should leave chat depth out of the internal config when audit.json omits it', () => {
    // An absent key keeps every digest the config had before chat depth
    // was configurable, so earlier bundles still verify.
    const config = toAuditConfig(exampleFile);

    expect(Object.keys(config)).not.toContain('chatProbes');
  });

  it('should refuse a depth outside 1 to 25 runs per prompt', () => {
    const tooDeep = auditFileSchema.safeParse({
      ...exampleAuditFile,
      chatProbes: { runsPerPrompt: 26 },
    });
    const zero = auditFileSchema.safeParse({
      ...exampleAuditFile,
      agentProbes: { runsPerPrompt: 0 },
    });
    const deepAgents = auditFileSchema.safeParse({
      ...exampleAuditFile,
      agentProbes: { runsPerPrompt: 25 },
    });

    expect(tooDeep.success).toBe(false);
    expect(zero.success).toBe(false);
    expect(deepAgents.success).toBe(true);
  });

  it('should refuse a misspelled agent depth instead of measuring at the default', () => {
    const misspelled = auditFileSchema.safeParse({
      ...exampleAuditFile,
      agentProbes: { runPerPrompt: 12 },
    });

    expect(misspelled.error?.issues).toContainEqual(
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['runPerPrompt'],
        path: ['agentProbes'],
      }),
    );
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

/**
 * stubPreflightMachine gives preflight a machine without agent CLIs: the
 * Codex check only needs a binary that starts (the dependency's own is
 * tested in codex-binary.spec.ts), and an empty PATH keeps the detection of
 * `claude` and `cursor-agent` from starting whatever this machine has
 * installed, which made the result and its duration depend on the machine.
 */
const stubPreflightMachine = () => {
  vi.stubEnv('AEO_CODEX_BIN', process.execPath);
  vi.stubEnv('PATH', path.join(root, 'no-agent-clis'));
};

describe('preflight - runPreflight()', () => {
  beforeEach(() => {
    stubPreflightMachine();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const settingsOf = async (lines: string) => {
    const envFile = path.join(root, 'settings.env');

    // The env file is the only source: the developer's own values never
    // reach these checks.
    for (const name of [
      'AI_GATEWAY_API_KEY',
      'DATAFORSEO_LOGIN',
      'DATAFORSEO_PASSWORD',
      'OPENAI_API_KEY',
      'CODEX_HOME',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
    ]) {
      vi.stubEnv(name, undefined);
    }

    await writeFile(envFile, lines);

    return readSettings(envFile);
  };

  it('should require the gateway key for the host calls even when only coding agents are measured', async () => {
    const checks = await runPreflight({
      surfaces: ['codex'],
      bindings: defaultProbeBindings,
      settings: await settingsOf(''),
      dir: path.join(root, 'run'),
    });

    expect(
      checks.find((check) => check.name === 'AI_GATEWAY_API_KEY'),
    ).toMatchObject({
      ok: false,
    });
  });

  it('should list each bound adapter with its settings by name and source, never by value', async () => {
    const checks = await runPreflight({
      surfaces: ['chatgpt', 'google_ai_overview'],
      bindings: defaultProbeBindings,
      settings: await settingsOf(
        'AI_GATEWAY_API_KEY=fake-secret-value-1\nDATAFORSEO_LOGIN=fake-login\n',
      ),
      dir: path.join(root, 'run'),
    });

    expect(checks.find((check) => check.name === 'chatgpt probes')).toEqual({
      name: 'chatgpt probes',
      ok: true,
      detail:
        'gateway.openai@1 with openai/gpt-6-luna; AI_GATEWAY_API_KEY from the env file',
    });
    expect(
      checks.find((check) => check.name === 'google_ai_overview probes'),
    ).toEqual({
      name: 'google_ai_overview probes',
      ok: false,
      detail:
        'dataforseo.ai_overview@1; DATAFORSEO_LOGIN from the env file; DATAFORSEO_PASSWORD not set',
    });
    expect(JSON.stringify(checks)).not.toContain('fake-secret-value-1');
  });

  it('should require the DataForSEO login for a consumer app, and none for a run that lists none', async () => {
    const settings = await settingsOf(
      'AI_GATEWAY_API_KEY=fake-secret-value-1\n',
    );
    const withApp = await runPreflight({
      surfaces: ['chatgpt', 'chatgpt_app'],
      bindings: defaultProbeBindings,
      settings,
      dir: path.join(root, 'run'),
    });
    const without = await runPreflight({
      surfaces: ['chatgpt'],
      bindings: defaultProbeBindings,
      settings,
      dir: path.join(root, 'run'),
    });

    expect(
      withApp.find((check) => check.name === 'chatgpt_app probes'),
    ).toEqual({
      name: 'chatgpt_app probes',
      ok: false,
      detail:
        'dataforseo.chatgpt_app@1; DATAFORSEO_LOGIN not set; DATAFORSEO_PASSWORD not set',
    });
    expect(
      withApp.find((check) => check.name === 'DATAFORSEO_LOGIN'),
    ).toMatchObject({ ok: false });
    expect(without.map((check) => check.name)).not.toContain(
      'DATAFORSEO_LOGIN',
    );
  });

  it("should accept any one of a coding agent's grouped auth settings, and disclose Codex billed outside the cap", async () => {
    expect(
      agentAuthMode('codex', await settingsOf('CODEX_HOME=/fake/codex-home\n')),
    ).toEqual({ kind: 'variable', name: 'CODEX_HOME' });
    expect(agentAuthMode('codex', await settingsOf(''))).toEqual({
      kind: 'cli_session',
    });

    vi.stubEnv('AEO_CODEX_BIN', process.execPath);
    const checks = await runPreflight({
      surfaces: ['codex'],
      bindings: defaultProbeBindings,
      settings: await settingsOf('OPENAI_API_KEY=fake-openai-key\n'),
      dir: path.join(root, 'run'),
    });

    expect(
      checks.find((check) => check.name === 'codex probes')?.detail,
    ).toContain(
      "authenticates with OPENAI_API_KEY, billed to that OpenAI account outside the run's cap",
    );
  });

  it('should disclose Claude Code on an API key as billed outside the cap, and on a subscription token as not', async () => {
    // A fake `claude` that only reports its version, alone on PATH with
    // the Node it runs on; HOME here, so it reads its mode from this
    // directory and writes nowhere else.
    const bin = path.join(root, 'bin');

    await mkdir(bin, { recursive: true });
    await symlink(fakeCliPath, path.join(bin, 'claude'));
    await symlink(process.execPath, path.join(bin, 'node'));
    await writeFile(path.join(root, '.fake-cli-mode'), 'version');
    vi.stubEnv('HOME', root);
    vi.stubEnv('PATH', bin);

    const detailWith = async (lines: string) => {
      const checks = await runPreflight({
        surfaces: ['claude_code'],
        bindings: defaultProbeBindings,
        settings: await settingsOf(lines),
        dir: path.join(root, 'run'),
      });

      return checks.find((check) => check.name === 'claude_code probes')
        ?.detail;
    };

    expect(await detailWith('ANTHROPIC_API_KEY=fake-anthropic-key\n')).toMatch(
      /fake-cli 0\.0\.1; authenticates with ANTHROPIC_API_KEY, billed to that Anthropic account outside the run's cap$/,
    );
    expect(await detailWith('CLAUDE_CODE_OAUTH_TOKEN=fake-token\n')).toMatch(
      /; authenticates with CLAUDE_CODE_OAUTH_TOKEN$/,
    );
  });

  it('should ask for the DataForSEO pair only when AI Overviews are measured', async () => {
    const envFile = path.join(root, 'empty.env');

    await writeFile(envFile, '');
    const settings = await readSettings(envFile);

    const chatOnly = await runPreflight({
      surfaces: ['chatgpt'],
      bindings: defaultProbeBindings,
      settings,
      dir: path.join(root, 'run'),
    });
    const withOverviews = await runPreflight({
      surfaces: ['chatgpt', 'google_ai_overview'],
      bindings: defaultProbeBindings,
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

  it('should check Chromium only when money pages are rendered, and name the install command when it is missing', async () => {
    const envFile = path.join(root, 'empty.env');

    await writeFile(envFile, '');
    const settings = await readSettings(envFile);
    const preflight = (rendersPages: boolean) => {
      return runPreflight({
        surfaces: ['chatgpt'],
        bindings: defaultProbeBindings,
        settings,
        dir: path.join(root, 'run'),
        rendersPages,
      });
    };
    const chromiumOf = (checks: { name: string }[]) => {
      return checks.find((check) => check.name === 'chromium (money pages)');
    };

    browser.installed = false;
    const missing = chromiumOf(await preflight(true));
    const notNeeded = chromiumOf(await preflight(false));

    browser.installed = true;
    const present = chromiumOf(await preflight(true));

    expect(notNeeded).toBeUndefined();
    expect(missing).toMatchObject({ ok: false });
    expect(missing).toHaveProperty(
      'detail',
      expect.stringMatching(/npx playwright@\d+\.\d+\.\d+ install chromium/),
    );
    expect(present).toMatchObject({ ok: true });
  });
});

describe('budget - resolveRunBudget()', () => {
  const policy = { maxUsd: 10, maxTokens: 1_000, maxHours: 2 };
  const model = 'anthropic/claude-opus-5.5';
  const at = (iso: string) => () => new Date(iso);

  it('should freeze the budget and the model on the first run and keep them on a resume', async () => {
    const first = await resolveRunBudget(root, policy, {
      model,
      now: at('2026-11-03T10:00:00.000Z'),
    });
    const resumed = await resolveRunBudget(root, policy, {
      model,
      now: at('2026-11-03T15:00:00.000Z'),
    });

    expect(first.limits).toEqual({
      maxUsd: 10,
      maxTokens: 1_000,
      deadlineAt: '2026-11-03T12:00:00.000Z',
    });
    expect(resumed.limits).toEqual(first.limits);
    expect(resumed.model).toBe(model);
  });

  it('should NOT amend a run when only audit.json changed, and say so', async () => {
    await resolveRunBudget(root, policy, { model });

    const edited = await resolveRunBudget(
      root,
      { ...policy, maxUsd: 50 },
      { model },
    );

    expect(edited.limits.maxUsd).toBe(10);
    expect(edited.policyDiffers).toBe(true);
  });

  it('should raise limits through an amendment and record old and new values', async () => {
    await resolveRunBudget(root, policy, {
      model,
      now: at('2026-11-03T10:00:00.000Z'),
    });

    const amended = await resolveRunBudget(root, policy, {
      model,
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
    await resolveRunBudget(root, policy, { model });

    const result = resolveRunBudget(root, policy, {
      model,
      amendment: { maxTokens: 10 },
    });

    await expect(result).rejects.toThrow(/can only be raised/);
  });

  it('should NOT report audit.json as changed when the cap came from --max-usd, or was raised', async () => {
    const { maxUsd: _maxUsd, ...uncapped } = policy;

    await resolveRunBudget(root, uncapped, { model, maxUsd: 40 });

    const resumed = await resolveRunBudget(root, uncapped, { model });
    const raised = await resolveRunBudget(root, uncapped, {
      model,
      maxUsd: 60,
    });

    expect(resumed.policyDiffers).toBe(false);
    expect(raised.policyDiffers).toBe(false);
  });

  it('should refuse a new run without an approved cap, writing nothing', async () => {
    const { maxUsd: _maxUsd, ...uncapped } = policy;

    const result = resolveRunBudget(root, uncapped, { model });

    await expect(result).rejects.toThrow(BudgetCapMissingError);
    await expect(readFrozenBudget(root)).resolves.toBeUndefined();
  });

  it('should take the cap from --max-usd, and raise it on a resume as a recorded amendment', async () => {
    const { maxUsd: _maxUsd, ...uncapped } = policy;

    const first = await resolveRunBudget(root, uncapped, {
      model,
      maxUsd: 40,
    });
    const raised = await resolveRunBudget(root, uncapped, {
      model,
      maxUsd: 60,
    });

    expect(first.limits.maxUsd).toBe(40);
    expect(raised.limits.maxUsd).toBe(60);
    expect(raised.amended?.from.maxUsd).toBe(40);
  });

  it('should refuse a resume whose audit.json names another model', async () => {
    await resolveRunBudget(root, policy, { model });

    const result = resolveRunBudget(root, policy, {
      model: 'anthropic/claude-sonnet-5.5',
    });

    await expect(result).rejects.toThrow(RunModelChangedError);
    await expect(result).rejects.toThrow(/rejudge .* --model/);
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

describe('audit-file - money pages', () => {
  const withPages = (
    moneyPages: string[],
    checkHosts?: string[],
  ): ReturnType<typeof auditFileSchema.safeParse> => {
    return auditFileSchema.safeParse({
      ...exampleAuditFile,
      moneyPages,
      ...(checkHosts && { runPolicy: { checkHosts } }),
    });
  };

  it('should accept pages on the brand site, its www and its subdomains', () => {
    const result = withPages([
      'https://northwind.example/pricing',
      'https://www.northwind.example/',
      'https://docs.northwind.example/start',
    ]);

    expect(result.success).toBe(true);
  });

  it.each([
    ['plain http', 'http://northwind.example/pricing'],
    ['a port', 'https://northwind.example:8443/'],
    ['credentials', 'https://user:secret@northwind.example/'],
    ['a private address', 'https://10.0.0.1/'],
    ['the metadata address', 'https://169.254.169.254/latest/meta-data'],
    ['localhost', 'https://localhost/'],
  ])('should refuse a page with %s', (_case, page) => {
    expect(withPages([page]).success).toBe(false);
  });

  it('should refuse a page on another host, naming runPolicy.checkHosts', () => {
    const result = withPages(['https://docs.acme.example/']);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('runPolicy.checkHosts');
  });

  it('should accept a page on a host named in runPolicy.checkHosts, and NOT change the measurement', () => {
    const allowed = withPages(['https://docs.acme.example/'], ['acme.example']);
    const plain = withPages(['https://docs.acme.example/']);

    expect(allowed.success).toBe(true);
    expect(plain.success).toBe(false);

    const file = requireDefined(allowed.data, 'the allowed audit file');
    const without = planLocalRun({
      ...file,
      runPolicy: { ...file.runPolicy, checkHosts: [] },
    });

    expect(planLocalRun(file).digests).toEqual(without.digests);
  });

  it.each([
    ['a URL', 'https://acme.example/'],
    ['a private address', '10.0.0.1'],
    ['a local name', 'printer.local'],
    ['a port', 'acme.example:8443'],
  ])('should refuse %s as a check host', (_case, host) => {
    expect(withPages([], [host]).success).toBe(false);
  });

  it('should refuse more than 20 money pages', () => {
    const pages = Array.from(
      { length: 21 },
      (_, index) => `https://northwind.example/${index}`,
    );

    expect(withPages(pages).success).toBe(false);
  });
});

describe('preflight - grounding search', () => {
  beforeEach(() => {
    stubPreflightMachine();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should ask for the DataForSEO pair when full grounding searches through it', async () => {
    const envFile = path.join(root, 'empty.env');

    await writeFile(envFile, '');
    const settings = await readSettings(envFile);
    const checks = await runPreflight({
      surfaces: ['chatgpt'],
      bindings: defaultProbeBindings,
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
    const {
      author: _author,
      runPolicy: _runPolicy,
      model: _model,
      ...measured
    } = proposal;
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

describe('run-configuration - recordRunConfiguration()', () => {
  it('should record the model a rejudgment ran with, not the source file', async () => {
    const configFile = path.join(root, 'source-audit.json');
    const dir = path.join(root, 'rejudged');

    await mkdir(dir, { recursive: true });
    await writeFile(configFile, JSON.stringify(exampleFile));

    await recordRunConfiguration({
      dir,
      configFile,
      evidence: { kind: 'manual' },
      model: 'anthropic/claude-sonnet-5.5',
    });

    const recorded = await readAuditFile(path.join(dir, auditCopyFile));

    expect(recorded.model).toBe('anthropic/claude-sonnet-5.5');
    expect(recorded.brand).toEqual(exampleFile.brand);
  });
});
