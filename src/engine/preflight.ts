import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  agentAuthEnv,
  cliNameForSurface,
  detectAgentClis,
  versionForSurface,
} from '../probes/agent-clis';
import {
  bindingOf,
  probeAdapterProfiles,
  profileOf,
  type ProbeBinding,
  type RunBindings,
} from '../probes/bindings';
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
  resolveSupportedModel,
  type SupportedModel,
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

// The engine's own secrets, outside the probe adapters' settings.
export const engineSecretSettingNames = [
  'AI_GATEWAY_API_KEY',
  'DATAFORSEO_PASSWORD',
  'AEO_DATABASE_URL',
  'AEO_SITE_DATABASE_URL',
  'AEO_API_TOKEN',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'PERPLEXITY_API_KEY',
] as const;

// The run's own credentials, by variable name: their values never enter a
// bundle. Values only; the names are not secret. A probe adapter's
// non-secret settings (a login name, a directory) stay out, or an export
// would refuse a bundle that merely mentions them.
export const credentialSettingNames: readonly string[] = [
  ...new Set([
    ...engineSecretSettingNames,
    ...Object.values(probeAdapterProfiles).flatMap((profile) =>
      profile.settings
        .filter((setting) => setting.secret)
        .map((setting) => setting.name),
    ),
  ]),
];

/** Every setting a run may read, for applying the env file. */
export const runSettingNames = [
  gatewaySetting,
  ...overviewSettings,
  ...Object.values(agentAuthEnv).flatMap((auth) => auth.anyOf),
];

// A coding agent's probes bill its own plan, outside the run's cap; an
// auth setting that bills a provider account per use (an API key) says so,
// since the cap does not see that spend either.
const agentAuthDetail = (
  binding: ProbeBinding,
  auth: ReturnType<typeof agentAuthMode>,
): string => {
  if (auth.kind === 'cli_session') {
    return 'uses the CLI login on this machine, checked by a canary before the run';
  }

  const account = profileOf(binding).settings.find(
    (setting) => setting.name === auth.name,
  )?.billsAccount;

  return account === undefined
    ? `authenticates with ${auth.name}`
    : `authenticates with ${auth.name}, billed to that ${account} account outside the run's cap`;
};

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

const sourceLabel = (name: string, settings: Settings): string => {
  const source = settings.sourceOf(name);

  if (source === undefined) {
    return `${name} not set`;
  }

  return `${name} from the ${source === 'environment' ? 'process environment' : 'env file'}`;
};

/** bindingLabel names an adapter and the model it is bound to. */
const bindingLabel = (binding: ProbeBinding): string => {
  return binding.model === undefined
    ? binding.adapter
    : `${binding.adapter} with ${binding.model}`;
};

/** A chat surface's bound adapter, with the settings it needs by name and
 * where each is set, never its value. */
const chatBindingCheck = (
  surface: AeoSurface,
  binding: ProbeBinding,
  settings: Settings,
): PreflightCheck => {
  const required = profileOf(binding).settings.filter(
    (setting) => setting.group === undefined,
  );

  return {
    name: `${surface} probes`,
    ok: required.every(
      (setting) => settings.sourceOf(setting.name) !== undefined,
    ),
    detail: [
      bindingLabel(binding),
      ...required.map((setting) => sourceLabel(setting.name, settings)),
    ].join('; '),
  };
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

/** The command that installs the Chromium this package's Playwright drives;
 * an unversioned `npx playwright` may fetch another release's browser. */
const chromiumInstallCommand = (): string => {
  const manifest: unknown = createRequire(import.meta.url)(
    'playwright/package.json',
  );
  const version =
    typeof manifest === 'object' &&
    manifest !== null &&
    'version' in manifest &&
    typeof manifest.version === 'string'
      ? `@${manifest.version}`
      : '';

  return `npx playwright${version} install chromium`;
};

/** The renderability check renders every money page in Chromium: a
 * missing browser stops the run here, not after the probes were paid for. */
const chromiumCheck = async (): Promise<PreflightCheck> => {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const version = browser.version();

    await browser.close();

    return {
      name: 'chromium (money pages)',
      ok: true,
      detail: `Chromium ${version} launches`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : '';

    return {
      name: 'chromium (money pages)',
      ok: false,
      detail: `does not launch (${message}); run \`${chromiumInstallCommand()}\`, or remove moneyPages from audit.json`,
    };
  }
};

/** The report's models as a command resolved them (resolveReportModels),
 * or why one could not be priced. `writer` is the model audit.json names
 * to write the narrative, when it names one. */
export type PreflightModel =
  | {
      outcome: 'resolved';
      model: SupportedModel;
      named: boolean;
      writer?: SupportedModel;
    }
  | { outcome: 'refused'; reason: string };

const recommendedModel = (): PreflightModel => {
  return { outcome: 'resolved', model: resolveSupportedModel(), named: false };
};

/** The model the run judges with, and the one that writes its narrative
 * when the audit names another for that. Any gateway model is accepted
 * once it is priced; a report model the engine ships no settings for says
 * that it was never verified on the Codex stage runtime. */
export const modelCheck = (
  resolved: PreflightModel = recommendedModel(),
): PreflightCheck => {
  if (resolved.outcome === 'refused') {
    return {
      name: 'model',
      ok: false,
      detail: [
        resolved.reason,
        'literally-aeo ships verified settings for:',
        ...describeSupportedModels(),
      ].join('\n    '),
    };
  }

  const { model, named, writer } = resolved;
  const pricedOf = (priced: SupportedModel) => {
    const { input, output } = priced.pricingUsdPerMillion;

    return findSupportedModel(priced.id)
      ? []
      : [
          `priced from the gateway's model list on ${priced.pricingCheckedAt}, at up to ${input} in / ${output} out USD per million tokens`,
        ];
  };
  // The writer makes one request and runs no Codex stage, so the stage
  // runtime's verification says nothing of it.
  const written = writer
    ? [
        [`the narrative is written by ${writer.id}`, ...pricedOf(writer)].join(
          ', ',
        ),
      ]
    : [];

  return {
    name: 'model',
    ok: true,
    detail: [
      `${model.id}${named ? '' : ' (recommended; audit.json names none)'}`,
      `asked at effort ${model.stageReasoningEffort}`,
      ...pricedOf(model),
      model.stageRuntimeVerifiedAt === null
        ? 'not yet verified on the Codex stage runtime through the gateway'
        : `verified on the Codex stage runtime ${model.stageRuntimeVerifiedAt}`,
      ...written,
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
  /** The report model as the command resolved it; absent means the
   * recommended model. */
  model?: PreflightModel;
  /** Full grounding researches through the pinned search provider. */
  groundingSearch?: boolean;
  /** Money pages are rendered in Chromium by the renderability check. */
  rendersPages?: boolean;
  /** The bindings the run measures with: each surface's adapter, whose
   * settings preflight requires. */
  bindings: RunBindings;
}): Promise<PreflightCheck[]> => {
  const { surfaces, settings, bindings } = args;
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
  ];

  // Each setting the run needs once: the gateway key always, for the
  // host's own model calls whatever is measured; every ungrouped setting of
  // a bound adapter in scope; and the search provider's pair when full
  // grounding searches through it, so a pinned provider never degrades to
  // `unavailable` searches mid-run (spec §3.3).
  const chatSurfaces = surfaces.filter((surface) => !isAgentSurface(surface));
  const required = new Set<string>([
    gatewaySetting,
    ...chatSurfaces.flatMap((surface) =>
      profileOf(bindingOf(bindings, surface))
        .settings.filter((setting) => setting.group === undefined)
        .map((setting) => setting.name),
    ),
    ...(args.groundingSearch ? overviewSettings : []),
  ]);

  checks.push(
    ...[...required].map((name) => settingCheck(name, settings)),
    ...chatSurfaces.map((surface) =>
      chatBindingCheck(surface, bindingOf(bindings, surface), settings),
    ),
  );

  // A coding agent authenticates with any one of its adapter's auth
  // settings, or with the CLI's own login, which only the canary can prove.
  for (const surface of agents) {
    const version = versionForSurface(surface, versions);
    const auth = agentAuthMode(surface, settings);
    const binding = bindingLabel(bindings[surface]);

    checks.push({
      name: `${surface} probes`,
      ok: version !== null,
      detail:
        version === null
          ? `${binding}; \`${cliNameForSurface(surface)}\` not found on PATH`
          : `${binding}; ${cliNameForSurface(surface)} ${version}; ${agentAuthDetail(bindings[surface], auth)}`,
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

  if (args.rendersPages) {
    checks.push(await chromiumCheck());
  }

  checks.push(await directoryCheck(args.dir));

  return checks;
};
