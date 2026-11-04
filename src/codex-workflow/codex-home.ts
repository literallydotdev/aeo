import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getEnvironment } from '../lib/env';
import type { CodexStageModel } from '../models/profiles';
import {
  codexBinaryVersion,
  resolveCodexBinary,
  type CodexBinary,
} from './codex-binary';

// ============================================================================
// An isolated Codex home per work directory (specs/aeo-codex-workflow-spec.md
// §7). Codex reads its configuration, auth and state from CODEX_HOME; giving
// every run its own, written by the host, means a stage can never inherit the
// operator's global model, service tier, MCP servers or login.
// ============================================================================

/** The gateway the Codex stages reach their model through. */
export const codexGateway = {
  provider: 'vercel',
  providerName: 'Vercel AI Gateway',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
  /** The environment variable the gateway key is read from; the only
   * secret the child process sees. */
  apiKeyEnv: 'AI_GATEWAY_API_KEY',
  wireApi: 'responses',
} as const;

/** Everything a stage's Codex configuration says about its model, in a
 * fixed key order: part of every stage's inputs digest and session
 * contract, so a resume reruns a batch only when the model changed. */
export type CodexStageConfig = typeof codexGateway &
  Pick<CodexStageModel, 'model' | 'reasoningEffort' | 'contextWindow'>;

export const codexStageConfig = (
  stageModel: CodexStageModel,
): CodexStageConfig => {
  const config: CodexStageConfig = {
    ...codexGateway,
    model: stageModel.model,
    reasoningEffort: stageModel.reasoningEffort,
    contextWindow: stageModel.contextWindow,
  };

  return config;
};

export const codexHomeDir = (workdir: string): string => {
  return path.join(workdir, '.codex-home');
};

/** The research tool server the author stage's home registers
 * (specs/aeo-codex-author-spec.md §3.1): the command Codex starts over
 * stdio and the environment it runs with, the search credentials included.
 * No other stage's home registers it. */
export type ResearchServerConfig = {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
};

const tomlString = (value: string): string => {
  return JSON.stringify(value);
};

/** The whole configuration a stage runs with, as Codex reads it. The work
 * directory is the only writable root: a session must not touch /tmp (an
 * empty /tmp/.git appeared during a run, 2026-09-13), unless the work
 * directory itself lives there, as it does in the container. */
type CodexConfigOptions = {
  stageModel: CodexStageModel;
  research?: ResearchServerConfig;
};

export const codexConfigToml = (
  workdir: string,
  { stageModel, research }: CodexConfigOptions,
): string => {
  const codexModel = codexStageConfig(stageModel);
  const underTmp = workdir === '/tmp' || workdir.startsWith('/tmp/');

  return [
    `model = "${codexModel.model}"`,
    `model_provider = "${codexModel.provider}"`,
    `model_reasoning_effort = "${codexModel.reasoningEffort}"`,
    `model_context_window = ${codexModel.contextWindow}`,
    // The report stages receive their own frozen rule files. Repository
    // engineering instructions and skills belong to the operator session.
    `project_doc_max_bytes = 0`,
    `project_root_markers = [".aeo-report-root"]`,
    ``,
    // These file-only stages need no plugin catalog or its per-run download.
    `[features]`,
    `plugins = false`,
    `remote_plugin = false`,
    ``,
    `[model_providers.${codexModel.provider}]`,
    `name = "${codexModel.providerName}"`,
    `base_url = "${codexModel.baseUrl}"`,
    `env_key = "${codexModel.apiKeyEnv}"`,
    `wire_api = "${codexModel.wireApi}"`,
    ``,
    `[history]`,
    `persistence = "none"`,
    ``,
    `[shell_environment_policy.set]`,
    `TMPDIR = ${JSON.stringify(path.join(workdir, '.tmp'))}`,
    `TMPPREFIX = ${JSON.stringify(path.join(workdir, '.tmp', 'zsh'))}`,
    ``,
    ...(underTmp
      ? []
      : [
          `[sandbox_workspace_write]`,
          `exclude_slash_tmp = true`,
          `exclude_tmpdir_env_var = true`,
          ``,
        ]),
    // `codex exec` runs with approval_policy never (verified 2026-09-15):
    // a tool call is refused unless pre-approved. The read tools declare
    // readOnlyHint, which the default approval mode accepts; `submit`
    // writes and is approved here by name.
    ...(research
      ? [
          `[mcp_servers.research]`,
          `command = ${tomlString(research.command)}`,
          `args = [${research.args.map(tomlString).join(', ')}]`,
          `startup_timeout_sec = 30`,
          `tool_timeout_sec = 120`,
          ``,
          `[mcp_servers.research.env]`,
          ...Object.entries(research.env).map(
            ([key, value]) => `${key} = ${tomlString(value)}`,
          ),
          ``,
          `[mcp_servers.research.tools.submit]`,
          `approval_mode = "approve"`,
          ``,
        ]
      : []),
  ].join('\n');
};

/** Write the isolated home and return the environment a stage runs with:
 * the path, the home, and the gateway key. Nothing else from the host. */
type PrepareCodexHomeOptions = CodexConfigOptions & {
  env?: Record<string, string | undefined>;
};

export const prepareCodexHome = async (
  workdir: string,
  { stageModel, research, env = getEnvironment() }: PrepareCodexHomeOptions,
): Promise<Record<string, string>> => {
  const apiKey = env[codexGateway.apiKeyEnv];

  if (!apiKey) {
    throw new Error(
      `${codexGateway.apiKeyEnv} is not set; the Codex stages run on ${stageModel.model} through the gateway and need it.`,
    );
  }

  const home = codexHomeDir(workdir);
  const temporaryDirectory = path.join(workdir, '.tmp');

  await mkdir(home, { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  await writeFile(path.join(workdir, '.aeo-report-root'), '');
  await writeFile(
    path.join(home, 'config.toml'),
    codexConfigToml(workdir, { stageModel, research }),
  );

  return {
    PATH: env.PATH ?? '',
    HOME: home,
    CODEX_HOME: home,
    TMPDIR: temporaryDirectory,
    [codexGateway.apiKeyEnv]: apiKey,
  };
};

/** The version of the Codex binary the stages spawn, or null when it
cannot be started. The stages and the author run it from the host process
with an isolated home and the gateway key, so no agent credential is
involved. */
export const codexCliVersion = async (
  binary: CodexBinary = resolveCodexBinary(),
): Promise<string | null> => {
  return codexBinaryVersion(binary);
};

/** The values the work directory's journals must never carry: the store
 * URL and the gateway key, from wherever the host holds them. */
export const workflowSecrets = (env: NodeJS.ProcessEnv): string[] => {
  return [env.AEO_DATABASE_URL, env.AI_GATEWAY_API_KEY].filter(
    (value): value is string => Boolean(value),
  );
};
