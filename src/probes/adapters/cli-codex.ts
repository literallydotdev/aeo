import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { probeUsd } from '../../models/cost-coefficients';
import { ProbeAdapterId, type ProbeAdapterProfile } from '../adapter';
import { AgentStreamError, parseCodexEvents } from '../agent-cli-parsers';
import { childEnv } from '../child-process';
import {
  attachCliOutput,
  authSettingNames,
  execCli,
  withScratchDir,
  type AgentProbeFn,
} from './cli-process';

export const codexProfile: ProbeAdapterProfile = {
  id: ProbeAdapterId.CLI_CODEX,
  observes: { retrieval: 'queries_only', servedModel: 'raw' },
  settings: [
    {
      name: 'OPENAI_API_KEY',
      secret: true,
      group: 'auth',
      billsAccount: 'OpenAI',
    },
    { name: 'CODEX_HOME', secret: false, group: 'auth' },
  ],
  pool: 'codex',
  retry: 'agent',
  estimateUsd: probeUsd[ProbeAdapterId.CLI_CODEX],
  billing: 'subscription',
  resolvesRedirects: false,
};

// Codex's auth variables, nothing else from the parent (§4.5).
const codexEnvKeys = authSettingNames(codexProfile);

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
// `codex exec --json` emits JSONL events; the final agent message carries the
// answer (also written to --output-last-message as the robust capture path),
// and `web_search` items reveal whether live retrieval happened. Web search
// is enabled explicitly; the sandbox stays read-only — the probe asks a
// question, it must not touch the machine. Isolation flags (verified against
// codex-cli 0.148.0 and 0.150.1): --cd pins the working root to the scratch
// dir (without it Codex resets to the last trusted project — repo-context
// leakage), --ignore-user-config skips the operator's config.toml (auth
// still works), --ephemeral keeps probe sessions out of session history.
// `--sandbox read-only` relies on Landlock/seccomp; a container must allow
// them or Codex fails closed (hardening spec §3.4).

// The model a Codex probe measures is pinned per stack (`aeo:codexProbeModel`
// → AEO_CODEX_PROBE_MODEL): the CLI's own default is chosen server-side per
// account and changes across releases, which would silently move the
// measured surface between reports. Unset means the CLI default, recorded as
// no requested model.
const codexProbeModel = (env: NodeJS.ProcessEnv): string | null => {
  const model = env.AEO_CODEX_PROBE_MODEL?.trim() ?? '';

  return model === '' ? null : model;
};

// Read-only unless the runtime opts out: the probe asks a question, it must
// not touch the machine.
const codexSandboxOf = (env: NodeJS.ProcessEnv): string => {
  return env.AEO_CODEX_SANDBOX === 'danger-full-access'
    ? 'danger-full-access'
    : 'read-only';
};

/** The parameters a Codex probe runs with, as its request records them. */
export const codexRequestParameters = (env: NodeJS.ProcessEnv) => {
  return {
    cli: 'codex',
    model: codexProbeModel(env),
    sandbox: codexSandboxOf(env),
  };
};

export const runCodexProbe: AgentProbeFn = async (
  promptText,
  runtime,
  signal,
) => {
  return withScratchDir(runtime, 'codex', async (dir) => {
    const lastMessagePath = path.join(dir, 'last-message.txt');
    const requestedModel = codexProbeModel(runtime.env);
    const output = await execCli('codex', {
      cliArgs: [
        'exec',
        '--json',
        ...(requestedModel ? ['--model', requestedModel] : []),
        '--sandbox',
        codexSandboxOf(runtime.env),
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--ephemeral',
        '--cd',
        dir,
        '--output-last-message',
        lastMessagePath,
        '-c',
        'tools.web_search=true',
        promptText,
      ],
      cwd: dir,
      runtime,
      env: childEnv(runtime.env, codexEnvKeys),
      signal,
    });

    try {
      const parsed = parseCodexEvents(output.stdout);
      let lastMessage = parsed.lastMessage;

      // The --output-last-message file is authoritative; the JSONL scan is
      // the fallback for CLI versions without it.
      try {
        const fromFile = (await readFile(lastMessagePath, 'utf8')).trim();

        if (fromFile) {
          lastMessage = fromFile;
        }
      } catch {
        // File absent — keep the JSONL-derived message.
      }

      if (!lastMessage) {
        throw new AgentStreamError(
          'cli_error',
          'Codex returned no agent message',
        );
      }

      return {
        text: lastMessage,
        requestedModel,
        usedWebSearch: parsed.usedWebSearch,
        retrieval: parsed.retrieval,
      };
    } catch (error) {
      throw attachCliOutput(error, output);
    }
  });
};
