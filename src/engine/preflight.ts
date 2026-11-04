import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  agentAuthEnv,
  cliNameForSurface,
  detectAgentClis,
  versionForSurface,
} from '../probes/agent-clis';
import {
  agentSurfaces,
  isAgentSurface,
  type AeoAgentSurface,
  type AeoSurface,
} from '../schema';
import {
  codexBinaryVersion,
  resolveCodexBinary,
} from '../codex-workflow/codex-binary';
import {
  describeSupportedModels,
  findSupportedModel,
  recommendedModelId,
} from '../models/supported-models';
import type { Settings } from './env-file';

// ============================================================================
// doctor (specs/aeo-open-source-cli-spec.md §4.2, §4.3): local prerequisites
// checked without a network call. Settings are listed by name and source,
// never by value. Whether a credential works is a canary's question, asked
// by `run` before the audit workload; doctor only says what is present.
// ============================================================================

export const minimumNodeMajor = 24;

export type PreflightCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

/** The settings each part of a run needs, by surface. */
const gatewaySetting = 'AI_GATEWAY_API_KEY';
const overviewSettings = ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'] as const;

// The run's own credentials, by variable name: their values never enter a
// bundle. Values only; the names are not secret.
export const credentialSettingNames = [
  'AI_GATEWAY_API_KEY',
  'DATAFORSEO_PASSWORD',
  'AEO_DATABASE_URL',
  'AEO_SITE_DATABASE_URL',
  'AEO_API_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'PERPLEXITY_API_KEY',
  'CURSOR_API_KEY',
] as const;

/** Every setting a run may read, for applying the env file. */
export const runSettingNames = [
  gatewaySetting,
  ...overviewSettings,
  ...Object.values(agentAuthEnv).flatMap((auth) => auth.anyOf),
];

/** How an agent surface authenticates on this machine: a variable, or the
 * CLI's own login, which only the run's canary can prove. */
export const agentAuthMode = (
  surface: AeoAgentSurface,
  settings: Settings,
): { kind: 'variable'; name: string } | { kind: 'cli_session' } => {
  const name = agentAuthEnv[surface].anyOf.find(
    (candidate) => settings.sourceOf(candidate) !== undefined,
  );

  return name === undefined
    ? { kind: 'cli_session' }
    : { kind: 'variable', name };
};

const settingCheck = (name: string, settings: Settings): PreflightCheck => {
  const source = settings.sourceOf(name);

  return {
    name,
    ok: source !== undefined,
    detail:
      source === undefined
        ? `set it in the environment or in ${settings.file}`
        : `set (from the ${source === 'environment' ? 'process environment' : 'env file'})`,
  };
};

const directoryCheck = async (dir: string): Promise<PreflightCheck> => {
  const probe = path.join(dir, `.doctor-${process.pid}`);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, '');
    await rm(probe, { force: true });

    return { name: 'run directory', ok: true, detail: `${dir} is writable` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { name: 'run directory', ok: false, detail: `${dir}: ${message}` };
  }
};

/** The model audit.json names, or the recommended one: refused when it is
 * not on the supported list, which the detail then prints. */
export const modelCheck = (model: string | undefined): PreflightCheck => {
  const id = model ?? recommendedModelId;
  const supported = findSupportedModel(id);

  if (!supported) {
    return {
      name: 'model',
      ok: false,
      detail: [
        `${id} is not supported; use one of:`,
        ...describeSupportedModels(),
      ].join('\n    '),
    };
  }

  return {
    name: 'model',
    ok: true,
    detail: [
      `${supported.id}${model === undefined ? ' (recommended; audit.json names none)' : ''}`,
      supported.stageRuntimeVerifiedAt === null
        ? 'not yet verified on the Codex stage runtime through the gateway'
        : `verified on the Codex stage runtime ${supported.stageRuntimeVerifiedAt}`,
    ].join('; '),
  };
};

/** The Codex the stages run: this package's own, unless overridden. */
const codexCheck = async (): Promise<PreflightCheck> => {
  try {
    const binary = resolveCodexBinary();
    const version = await codexBinaryVersion(binary);
    const origin =
      binary.source === 'dependency'
        ? "the package's own pinned dependency"
        : `AEO_CODEX_BIN=${binary.path}`;

    return {
      name: 'codex (stage runtime)',
      ok: version !== null,
      detail:
        version === null
          ? `${binary.path} did not start; reinstall literally-aeo`
          : `${version}, from ${origin}`,
    };
  } catch (err) {
    return {
      name: 'codex (stage runtime)',
      ok: false,
      detail: `not installed with the package (${err instanceof Error ? err.message : String(err)}); reinstall literally-aeo`,
    };
  }
};

/** runPreflight checks what a run over these surfaces needs locally. */
export const runPreflight = async (args: {
  surfaces: readonly AeoSurface[];
  settings: Settings;
  dir: string;
  /** audit.json's `model`; absent means the recommended model. */
  model?: string;
  /** Full grounding researches through the pinned search provider. */
  groundingSearch?: boolean;
}): Promise<PreflightCheck[]> => {
  const { surfaces, settings } = args;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const versions = await detectAgentClis();
  const agents = surfaces.filter(isAgentSurface);

  const checks: PreflightCheck[] = [
    {
      name: 'node',
      ok: nodeMajor >= minimumNodeMajor,
      detail: `${process.version} (${minimumNodeMajor} or newer required)`,
    },
    modelCheck(args.model),
    // Every stage session runs on Codex, whatever is measured.
    await codexCheck(),
    settingCheck(gatewaySetting, settings),
  ];

  // A pinned search provider without its credential never degrades to
  // `unavailable` searches mid-run (spec §3.3).
  if (surfaces.includes('google_ai_overview') || args.groundingSearch) {
    checks.push(
      ...overviewSettings.map((name) => settingCheck(name, settings)),
    );
  }

  for (const surface of agents) {
    const version = versionForSurface(surface, versions);
    const auth = agentAuthMode(surface, settings);

    checks.push({
      name: `${surface} probes`,
      ok: version !== null,
      detail:
        version === null
          ? `\`${cliNameForSurface(surface)}\` not found on PATH`
          : `${cliNameForSurface(surface)} ${version}; ${auth.kind === 'variable' ? `authenticates with ${auth.name}` : 'uses the CLI login on this machine, checked by a canary before the run'}`,
    });
  }

  // Which coding-agent CLIs this machine has, for a config that would
  // measure them: what to install or log in to, or what to leave out.
  for (const surface of agentSurfaces) {
    if (agents.includes(surface)) {
      continue;
    }

    const version = versionForSurface(surface, versions);

    checks.push({
      name: `${surface} CLI`,
      ok: true,
      detail:
        version === null
          ? `\`${cliNameForSurface(surface)}\` not installed; needed only when the config measures coding agents`
          : `${cliNameForSurface(surface)} ${version} installed; this config does not measure it`,
    });
  }

  checks.push(await directoryCheck(args.dir));

  return checks;
};
