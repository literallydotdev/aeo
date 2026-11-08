import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeUsd } from '../../models/cost-coefficients';
import { ProbeAdapterId, type ProbeAdapterProfile } from '../adapter';
import { parseCursorStream } from '../agent-cli-parsers';
import { childEnv } from '../child-process';
import {
  attachCliOutput,
  authSettingNames,
  execCli,
  withScratchDir,
  type AgentProbeFn,
} from './cli-process';

export const cursorProfile: ProbeAdapterProfile = {
  id: ProbeAdapterId.CLI_CURSOR,
  observes: { retrieval: 'full', servedModel: 'raw' },
  settings: [{ name: 'CURSOR_API_KEY', secret: true, group: 'auth' }],
  pool: 'cursor',
  retry: 'agent',
  estimateUsd: probeUsd.cursor,
  billing: 'subscription',
  resolvesRedirects: false,
};

// Cursor's auth variable, nothing else from the parent (§4.5).
const cursorEnvKeys = authSettingNames(cursorProfile);

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------
// `cursor-agent -p --output-format stream-json --trust --force` with a
// project config in the scratch dir that denies command execution and file
// mutation. Headless `--trust` alone cannot approve anything, so every web
// search and fetch came back `result.rejected: "User Rejected"` — and the
// old regex detection matched the REQUEST event, flagging 150 of 192
// committed Cursor rows as searched (correctness spec §1.1). `--force` is
// what makes the surface exist; the deny list is what keeps the shell off.
// Verified 2026-09-03 on 2026.09.02: web search returns `result.success`,
// every shell attempt returns `result.permissionDenied` ("Command blocked by
// permissions configuration"). The `allow` array is required by the config
// schema even when empty.
//
// Isolation (residual exposure, documented per §3.1): cursor-agent has no
// equivalent of Claude Code's --setting-sources. The scratch dir carries no
// project rules or project MCP config, and --approve-mcps is deliberately
// NOT passed, so servers needing approval stay off; but user-level
// ~/.cursor/mcp.json servers already approved on the operator machine and
// account-level user rules can still load into the probe. Review Cursor
// answers for operator-tooling leakage the way that vendor plugin leak was
// caught (a line like "I notice you have X set up"). Whether cursor-agent
// leaves a transcript under $HOME is unverified (hardening spec §2.8).

const cursorProjectConfig = {
  permissions: {
    allow: [],
    deny: ['Shell(*)', 'Write(*)', 'Edit(*)', 'Delete(*)'],
  },
};

export const runCursorProbe: AgentProbeFn = async (
  promptText,
  runtime,
  signal,
) => {
  return withScratchDir(runtime, 'cursor', async (dir) => {
    await mkdir(path.join(dir, '.cursor'), { recursive: true });
    await writeFile(
      path.join(dir, '.cursor', 'cli.json'),
      JSON.stringify(cursorProjectConfig),
      'utf8',
    );

    const output = await execCli('cursor-agent', {
      cliArgs: [
        '-p',
        promptText,
        '--output-format',
        'stream-json',
        '--trust',
        '--force',
      ],
      cwd: dir,
      runtime,
      env: childEnv(runtime.env, cursorEnvKeys),
      signal,
    });

    try {
      return parseCursorStream(output.stdout);
    } catch (error) {
      throw attachCliOutput(error, output);
    }
  });
};
