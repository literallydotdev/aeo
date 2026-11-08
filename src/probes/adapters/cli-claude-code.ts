import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeUsd } from '../../models/cost-coefficients';
import { ProbeAdapterId, type ProbeAdapterProfile } from '../adapter';
import { parseClaudeCodeStream } from '../agent-cli-parsers';
import { childEnv } from '../child-process';
import {
  attachCliOutput,
  authSettingNames,
  execCli,
  withScratchDir,
  type AgentProbeFn,
} from './cli-process';

export const claudeCodeProfile: ProbeAdapterProfile = {
  id: ProbeAdapterId.CLI_CLAUDE_CODE,
  observes: { retrieval: 'full', servedModel: 'raw' },
  settings: [
    { name: 'CLAUDE_CODE_OAUTH_TOKEN', secret: true, group: 'auth' },
    { name: 'ANTHROPIC_API_KEY', secret: true, group: 'auth' },
  ],
  pool: 'claude_code',
  retry: 'agent',
  estimateUsd: probeUsd.claude_code,
  billing: 'subscription',
  resolvesRedirects: false,
};

// Claude Code's auth variables and its config directory, nothing else from
// the parent (§4.5).
const claudeEnvKeys = [
  ...authSettingNames(claudeCodeProfile),
  'CLAUDE_CONFIG_DIR',
];

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
// `claude -p --output-format stream-json --verbose` streams NDJSON: every
// assistant turn with its tool_use blocks, the tool results, and a final
// `result` event with the answer and any permission denials. `--verbose` is
// mandatory (the CLI refuses stream-json in print mode without it). The old
// `--output-format json` path read `usage.server_tool_use.web_search_requests`,
// a counter that stays 0 for the CLI's own WebSearch/WebFetch tools — every
// committed Claude Code row said "from memory" (correctness spec §1.1).
// Isolated `--settings` file: web tools pre-allowed so the headless run never
// stalls on a permission prompt, everything else denied.
//
// Environment isolation (added 2026-08-22 after a real contamination):
// `--setting-sources project` drops the operator's user-scope config — the
// scratch dir has no project settings, so user plugins, skills, and CLAUDE.md
// never load. Without it, an installed vendor plugin leaks into the probe's
// system prompt and biases answers toward that vendor (one baseline captured
// "I notice you have <vendor> tooling set up in this environment").
// Verified 2026-09-03 on 2.1.251: the stream's init event reports
// `mcp_servers: []` and `plugins: []`. NOT `--bare` — it forces API-key-only
// auth and would break the accepted subscription-billing default. Claude
// Code's own built-in skills remain, which is the honest surface: every real
// user has those.

export const runClaudeCodeProbe: AgentProbeFn = async (
  promptText,
  runtime,
  signal,
) => {
  return withScratchDir(runtime, 'claude_code', async (dir) => {
    const settingsPath = path.join(dir, 'probe-settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        permissions: {
          // Bare tool names allow every use of the tool — the documented rule
          // form ('WebFetch(*)' is not valid rule syntax and would leave
          // fetches auto-denied in headless mode; the parser now turns that
          // denial into a loud rejected-tool failure).
          allow: ['WebSearch', 'WebFetch'],
          deny: ['Bash', 'Read', 'Edit', 'Write'],
        },
      }),
      'utf8',
    );

    const output = await execCli('claude', {
      cliArgs: [
        '-p',
        promptText,
        '--output-format',
        'stream-json',
        '--verbose',
        '--settings',
        settingsPath,
        '--strict-mcp-config',
        '--setting-sources',
        'project',
      ],
      cwd: dir,
      runtime,
      env: childEnv(
        runtime.env,
        claudeEnvKeys,
        runtime.claudeConfigDir
          ? { CLAUDE_CONFIG_DIR: runtime.claudeConfigDir }
          : {},
      ),
      signal,
    });

    try {
      return parseClaudeCodeStream(output.stdout);
    } catch (error) {
      throw attachCliOutput(error, output);
    }
  });
};
