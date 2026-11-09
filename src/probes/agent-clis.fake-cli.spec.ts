import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  claudeTranscriptDir,
  runAgentProbesForPrompts,
  runCanaryProbes,
  type AgentRuntime,
} from './agent-clis';
import { ChildProcessError, childEnv, runChild } from './child-process';
import { unlimited } from './limits';

// ============================================================================
// Fake CLI on PATH (hardening spec §6.2): the runner resolves `claude` and
// `cursor-agent` by name, and `codex` through AEO_CODEX_BIN, so a directory of symlinks to the
// fixture script stands in for all three. Modes exercise the child-process
// runner (timeout, kill escalation, buffer cap, environment allowlist) and
// the unit loop (typed outcomes, no argv in messages, banking failures,
// transcript cleanup).
// ============================================================================

const fakeCliPath = path.join(
  import.meta.dirname,
  '__fixtures__',
  'fake-cli',
  'fake-cli.mjs',
);

let binDir: string;
const homes: string[] = [];

beforeAll(async () => {
  binDir = await mkdtemp(path.join(tmpdir(), 'aeo-fake-cli-bin-'));

  for (const name of ['claude', 'codex', 'cursor-agent']) {
    await symlink(fakeCliPath, path.join(binDir, name));
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(binDir, { recursive: true, force: true });

  for (const home of homes) {
    await rm(home, { recursive: true, force: true });
  }
});

// The child gets only the allowlisted environment (PATH, HOME, auth), so
// the fake CLI reads its mode from a file under a per-test HOME.
const fakeEnv = async (
  mode: string,
  extra: Record<string, string> = {},
): Promise<NodeJS.ProcessEnv> => {
  const home = await mkdtemp(path.join(tmpdir(), 'aeo-fake-home-'));
  homes.push(home);
  await writeFile(path.join(home, '.fake-cli-mode'), mode, 'utf8');

  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: home,
    // Codex is the package's own dependency unless the runtime names another.
    AEO_CODEX_BIN: path.join(binDir, 'codex'),
    ...extra,
  };

  return env;
};

const runtime = async (
  mode: string,
  extra: Record<string, string> = {},
): Promise<AgentRuntime> => {
  return {
    env: await fakeEnv(mode, extra),
    claudeConfigDir: null,
    timeoutMs: 2_000,
  };
};

const testPrompt = {
  id: 'p1',
  promptText: 'What should I adopt?',
  category: 'comparison',
};

describe('child-process - runChild()', () => {
  it('should kill a hanging child on the deadline and report a timeout', async () => {
    const started = Date.now();
    await expect(
      runChild(path.join(binDir, 'claude'), [], {
        cwd: binDir,
        env: childEnv(await fakeEnv('hang'), []),
        timeoutMs: 300,
        maxBuffer: 1024 * 1024,
        killGraceMs: 200,
      }),
    ).rejects.toMatchObject({ result: { timedOut: true } });

    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('should escalate to SIGKILL when the child ignores SIGTERM', async () => {
    let error: unknown;

    try {
      await runChild(path.join(binDir, 'claude'), [], {
        cwd: binDir,
        env: childEnv(await fakeEnv('ignore-term'), []),
        timeoutMs: 300,
        maxBuffer: 1024 * 1024,
        killGraceMs: 200,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ChildProcessError);
    const { result } = error as ChildProcessError;
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('should stop a flooding child at the buffer cap', async () => {
    await expect(
      runChild(path.join(binDir, 'claude'), [], {
        cwd: binDir,
        env: childEnv(await fakeEnv('flood'), []),
        timeoutMs: 5_000,
        maxBuffer: 64 * 1024,
        killGraceMs: 200,
      }),
    ).rejects.toThrow(/output exceeded/);
  });

  it('should hand the child only the allowlisted environment', async () => {
    const result = await runChild(path.join(binDir, 'claude'), [], {
      cwd: binDir,
      env: childEnv(
        await fakeEnv('env-dump', {
          AI_GATEWAY_API_KEY: 'secret',
          DATAFORSEO_PASSWORD: 'secret',
          ANTHROPIC_API_KEY: 'allowed',
        }),
        ['ANTHROPIC_API_KEY'],
      ),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
    });

    const lastLine = result.stdout.trim().split('\n').at(-1) ?? '';
    const event = z.object({ result: z.string() }).parse(JSON.parse(lastLine));
    const env = JSON.parse(event.result) as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe('allowed');
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(env.DATAFORSEO_PASSWORD).toBeUndefined();
  });
});

describe('agent-clis - runAgentProbesForPrompts() with a fake CLI', () => {
  const versions = { claudeCode: 'fake', codex: 'fake', cursor: 'fake' };

  it('should capture an answer and record the retrieval log', async () => {
    const banked: string[] = [];
    const { outcomes } = await runAgentProbesForPrompts({
      prompts: [testPrompt],
      surfaces: ['claude_code'],
      versions,
      runsPerPrompt: 1,
      runtime: await runtime('searched'),
      limiter: unlimited(),
      onResult: (result) => {
        banked.push(result.text);

        return Promise.resolve();
      },
    });

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.status).toBe('captured');

    if (outcome?.status !== 'captured') {
      return;
    }

    expect(outcome.probe.usedWebSearch).toBe(true);
    expect(outcome.probe.retrieval?.calls).toHaveLength(1);
    expect(outcome.probe.agentCliVersion).toBe('fake');
    expect(banked).toEqual(['Searched answer https://a.example/']);
  });

  it('should never put the prompt into a failure message and should type the failure', async () => {
    const { outcomes } = await runAgentProbesForPrompts({
      prompts: [testPrompt],
      surfaces: ['claude_code'],
      versions,
      runsPerPrompt: 1,
      runtime: await runtime('exit1'),
      limiter: unlimited(),
    });

    const outcome = outcomes[0];
    expect(outcome?.status).toBe('failed');

    if (outcome?.status !== 'failed') {
      return;
    }

    expect(outcome.kind).toBe('cli_error');
    // One retry for an ordinary failure, then done.
    expect(outcome.attempts).toBe(2);
    expect(outcome.lastError).not.toContain(testPrompt.promptText);
    expect(outcome.lastError).toContain('something went wrong');
  }, 20_000);

  it('should classify auth errors without retrying and rejected web tools as configuration', async () => {
    const auth = await runAgentProbesForPrompts({
      prompts: [testPrompt],
      surfaces: ['codex'],
      versions,
      runsPerPrompt: 1,
      runtime: await runtime('auth-error'),
      limiter: unlimited(),
    });

    expect(auth.outcomes[0]).toMatchObject({
      status: 'failed',
      kind: 'auth',
      attempts: 1,
    });

    const rejected = await runAgentProbesForPrompts({
      prompts: [testPrompt],
      surfaces: ['claude_code'],
      versions,
      runsPerPrompt: 2,
      runtime: await runtime('reject-web-tool'),
      limiter: unlimited(),
    });

    expect(rejected.rejectedWebToolSurfaces).toEqual(['claude_code']);
    expect(
      rejected.outcomes.every(
        (o) => o.status === 'failed' && o.kind === 'rejected_web_tool',
      ),
    ).toBe(true);
  });

  it('should report a timeout as its own kind and a torn stream as a parser failure', async () => {
    const hung = await runAgentProbesForPrompts({
      prompts: [testPrompt],
      surfaces: ['claude_code'],
      versions,
      runsPerPrompt: 1,
      runtime: { ...(await runtime('hang')), timeoutMs: 300 },
      limiter: unlimited(),
    });

    expect(hung.outcomes[0]).toMatchObject({
      status: 'failed',
      kind: 'timeout',
    });

    const torn = await runAgentProbesForPrompts({
      prompts: [testPrompt],
      surfaces: ['claude_code'],
      versions,
      runsPerPrompt: 1,
      runtime: await runtime('torn'),
      limiter: unlimited(),
    });

    expect(torn.outcomes[0]).toMatchObject({
      status: 'failed',
      kind: 'parser',
    });
  }, 30_000);

  it('should turn a throwing banker into a persistence failure without re-running the probe', async () => {
    let calls = 0;
    const { outcomes } = await runAgentProbesForPrompts({
      prompts: [testPrompt],
      surfaces: ['claude_code'],
      versions,
      runsPerPrompt: 1,
      runtime: await runtime('ok'),
      limiter: unlimited(),
      onResult: () => {
        calls += 1;

        return Promise.reject(new Error('store down'));
      },
    });

    expect(outcomes[0]).toMatchObject({
      status: 'failed',
      kind: 'persistence',
      attempts: 1,
      lastError: 'store down',
    });

    expect(calls).toBe(1);
  });

  it('should stop dispatch when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { outcomes } = await runAgentProbesForPrompts({
      prompts: [testPrompt],
      surfaces: ['claude_code'],
      versions,
      runsPerPrompt: 2,
      runtime: await runtime('ok'),
      limiter: unlimited(),
      signal: controller.signal,
    });

    expect(outcomes).toHaveLength(2);
    expect(
      outcomes.every((o) => o.status === 'failed' && o.attempts === 0),
    ).toBe(true);
  });

  it('should ask Codex for the pinned probe model and record it, or record none', async () => {
    const probe = async (extra: Record<string, string>) => {
      const { outcomes } = await runAgentProbesForPrompts({
        prompts: [testPrompt],
        surfaces: ['codex'],
        versions,
        runsPerPrompt: 1,
        runtime: await runtime('echo-args', extra),
        limiter: unlimited(),
      });
      const outcome = outcomes[0];

      if (outcome?.status !== 'captured') {
        throw new Error(`Codex probe ${outcome?.status ?? 'missing'}.`);
      }

      return {
        args: JSON.parse(outcome.probe.text) as string[],
        requestedModel: outcome.probe.requestedModel,
      };
    };

    const pinned = await probe({ AEO_CODEX_PROBE_MODEL: 'gpt-5.6-sol' });

    expect(pinned.args[pinned.args.indexOf('--model') + 1]).toBe('gpt-5.6-sol');
    expect(pinned.requestedModel).toBe('gpt-5.6-sol');

    const unpinned = await probe({});

    expect(unpinned.args).not.toContain('--model');
    expect(unpinned.requestedModel).toBeNull();
  });

  it('should remove the Claude Code transcript directory of the scratch cwd', async () => {
    // The fake CLI writes nothing under $HOME; seed the transcript dir the
    // real CLI would create for the scratch cwd and check it is gone after.
    const rt = await runtime('echo-args');
    const seen: string[] = [];
    await runAgentProbesForPrompts({
      prompts: [testPrompt],
      surfaces: ['claude_code'],
      versions,
      runsPerPrompt: 1,
      runtime: rt,
      limiter: unlimited(),
      onResult: (result) => {
        const args = JSON.parse(result.text) as string[];
        const settings = args[args.indexOf('--settings') + 1];

        if (settings === undefined) {
          return Promise.reject(new Error('The CLI got no --settings path.'));
        }

        seen.push(claudeTranscriptDir(rt.env, path.dirname(settings)));

        return Promise.resolve();
      },
    });

    expect(seen).toHaveLength(1);
    // The fake CLI wrote a transcript there during the probe (as Claude
    // Code does); the scratch cleanup removed it.
    expect(seen[0]).toContain('-tmp-aeo-agent-probe-');
    const home = rt.env.HOME;

    if (home === undefined) {
      throw new Error('The fake runtime has no HOME.');
    }

    const projects = await readdir(path.join(home, '.claude', 'projects'));
    expect(projects).toEqual([]);
  });
});

describe('agent-clis - runCanaryProbes() with a fake CLI', () => {
  it('should pass with a working CLI and list every failing surface', async () => {
    await expect(
      runCanaryProbes(['claude_code', 'codex'], await runtime('ok')),
    ).resolves.toBeUndefined();

    await expect(
      runCanaryProbes(['claude_code', 'cursor'], await runtime('auth-error')),
    ).rejects.toThrow(/claude_code: auth[\s\S]*cursor: auth/);
  });
});
