import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getEnvironment } from '../lib/env';

// ============================================================================
// An isolated Codex home per work directory (specs/aeo-codex-workflow-spec.md
// §7). Codex reads its configuration, auth and state from CODEX_HOME; giving
// every run its own, written by the host, means a stage can never inherit the
// operator's global model, service tier, MCP servers or login. The first
// three local loops ran on the operator's default (GPT-6 Astra at xhigh on
// the priority tier) for exactly that reason.
// ============================================================================

/** The one model the workflow's stages run on: DeepSeek V4.1 Flash through
 * the Vercel AI Gateway, at the highest effort the family takes (the same
 * pin `src/models/profiles.ts` uses for the DeepSeek bulk roles). Part of
 * every stage's inputs digest. */
export const codexModel = {
  provider: 'vercel',
  providerName: 'Vercel AI Gateway',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
  /** The environment variable the gateway key is read from; the only
   * secret the child process sees. */
  apiKeyEnv: 'AI_GATEWAY_API_KEY',
  wireApi: 'responses',
  model: 'deepseek/deepseek-v4.1-flash',
  reasoningEffort: 'high',
  /** The model's context window as the gateway reports it (`/v1/models`,
   * 2026-09-13). Codex has no metadata for gateway models and otherwise
   * falls back to a default window, which decides when it compacts the
   * session history; a qualify or review batch that read ten answers and
   * their rows would be compacted for no reason. */
  contextWindow: 1_000_000,
} as const;

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
export const codexConfigToml = (
  workdir: string,
  research?: ResearchServerConfig,
): string => {
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
export const prepareCodexHome = async (
  workdir: string,
  env: Record<string, string | undefined> = getEnvironment(),
  research?: ResearchServerConfig,
): Promise<Record<string, string>> => {
  const apiKey = env[codexModel.apiKeyEnv];

  if (!apiKey) {
    throw new Error(
      `${codexModel.apiKeyEnv} is not set; the Codex stages run on ${codexModel.model} through the gateway and need it.`,
    );
  }

  const home = codexHomeDir(workdir);
  const temporaryDirectory = path.join(workdir, '.tmp');

  await mkdir(home, { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  await writeFile(path.join(workdir, '.aeo-report-root'), '');
  await writeFile(
    path.join(home, 'config.toml'),
    codexConfigToml(workdir, research),
  );

  return {
    PATH: env.PATH ?? '',
    HOME: home,
    CODEX_HOME: home,
    TMPDIR: temporaryDirectory,
    [codexModel.apiKeyEnv]: apiKey,
  };
};

/** The version of the Codex binary the stages spawn, or null when it is not
 * on PATH. This is the binary itself, not a probe worker's login: the
 * stages and the author run it from the host process with an isolated home
 * and the gateway key, so no agent credential is involved. */
export const codexCliVersion = async (
  command = 'codex',
): Promise<string | null> => {
  try {
    const { stdout } = await promisify(execFile)(command, ['--version'], {
      timeout: 15_000,
    });
    const [firstLine] = stdout.trim().split('\n');

    return firstLine === undefined || firstLine === '' ? null : firstLine;
  } catch {
    return null;
  }
};

/** The values the work directory's journals must never carry: the store
 * URL and the gateway key, from wherever the host holds them. */
export const workflowSecrets = (env: NodeJS.ProcessEnv): string[] => {
  return [env.AEO_DATABASE_URL, env.AI_GATEWAY_API_KEY].filter(
    (value): value is string => Boolean(value),
  );
};
