import { spawn, type ChildProcess } from 'node:child_process';
import { readEnv } from '../lib/env';

// ============================================================================
// Child processes for the agent CLIs (hardening spec §4.5, §3.4). Every CLI
// runs detached in its own process group, so the deadline kills the whole
// chain (the pnpm shim AND the Rust binary behind `codex`): SIGTERM to the
// group, then SIGKILL after a grace period. The promise races the runner's
// own deadline instead of trusting the child to exit. stdin is closed at
// once — the CLIs read a piped stdin until EOF — and the prompt travels as
// an argument, never through a shell.
// ============================================================================

export type ChildRunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  killGraceMs?: number;
  // Aborting kills the process group the same way a timeout does.
  signal?: AbortSignal;
};

export type ChildRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
};

/** A child that exited non-zero, was killed, or overflowed its buffers. */
export class ChildProcessError extends Error {
  readonly result: ChildRunResult;

  constructor(message: string, result: ChildRunResult) {
    super(message);
    this.result = result;
    this.name = 'ChildProcessError';
  }
}

const defaultKillGraceMs = 10_000;

/** The caller must spawn detached so a CLI launcher and its descendants
 * share a group separate from the host. The launcher may already be gone. */
export const killChildProcessGroup = (
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals,
): void => {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is gone; the direct child may still be reapable. Unlike
    // `process.kill`, `child.kill` returns false for an exited child rather
    // than throwing, so this catch only absorbs a signal the platform
    // refuses, which must not surface from a best-effort kill.
    try {
      child.kill(signal);
    } catch {
      // Intentionally ignored.
    }
  }
};

export const runChild = (
  command: string,
  args: readonly string[],
  options: ChildRunOptions,
): Promise<ChildRunResult> => {
  if (readEnv('AEO_ISOLATED_ADAPTER') === '1') {
    throw new Error('Container CLI calls must use isolated workers.');
  }

  const startedAt = Date.now();

  if (options.signal?.aborted) {
    return Promise.reject(
      new ChildProcessError('Invocation cancelled before dispatch', {
        stdout: '',
        stderr: '',
        code: null,
        signal: null,
        timedOut: false,
        aborted: true,
        durationMs: 0,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let overflowed = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const killGroup = (sig: NodeJS.Signals) => {
      killChildProcessGroup(child, sig);
    };

    const terminate = () => {
      killGroup('SIGTERM');
      killTimer = setTimeout(
        () => killGroup('SIGKILL'),
        options.killGraceMs ?? defaultKillGraceMs,
      );
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      terminate();
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (chunk: Buffer, current: string): string => {
      // Past the cap nothing more is kept: the child is being killed.
      if (overflowed) {
        return current;
      }

      const next = current + chunk.toString('utf8');

      if (next.length > options.maxBuffer) {
        overflowed = true;
        terminate();

        return next.slice(0, options.maxBuffer);
      }

      return next;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = collect(chunk, stdout);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = collect(chunk, stderr);
    });

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: Error,
    ) => {
      if (settled) {
        return;
      }

      settled = true;
      // The direct child may exit before a SIGTERM-resistant grandchild.
      // Reap its process group even when it closed its pipes successfully.
      killGroup('SIGKILL');
      clearTimeout(deadline);

      if (killTimer) {
        clearTimeout(killTimer);
      }

      options.signal?.removeEventListener('abort', onAbort);
      const result: ChildRunResult = {
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      };

      if (spawnError) {
        reject(new ChildProcessError(spawnError.message, result));
      } else if (timedOut) {
        reject(
          new ChildProcessError(
            `${command} exceeded its ${options.timeoutMs}ms deadline and was killed`,
            result,
          ),
        );
      } else if (aborted) {
        reject(
          new ChildProcessError(`${command} aborted by the runner`, result),
        );
      } else if (overflowed) {
        reject(
          new ChildProcessError(
            `${command} output exceeded ${options.maxBuffer} bytes`,
            result,
          ),
        );
      } else if (code !== 0) {
        reject(
          new ChildProcessError(
            signal
              ? `${command} was killed by ${signal}`
              : `${command} exited with code ${code}`,
            result,
          ),
        );
      } else {
        resolve(result);
      }
    };

    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
  });
};

// The child environment is an allowlist (§4.5): the process basics, the
// one auth variable a CLI needs, and the autoupdater switch. Never the
// whole parent environment — in a container that would hand the runner's
// database URL, the DataForSEO password and every vendor key to every
// vendor CLI.
const baseEnvKeys = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  // Where the CLIs keep config and auth when the operator relocated them.
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  // A container behind an egress proxy still needs the CLIs to reach out.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
];

/**
 * toProcessEnv types an allowlisted child environment for `spawn`.
 */
const toProcessEnv = (env: Record<string, string>): NodeJS.ProcessEnv => {
  return env;
};

export const childEnv = (
  source: NodeJS.ProcessEnv,
  keys: readonly string[],
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv => {
  const env: Record<string, string> = {};

  for (const key of [...baseEnvKeys, ...keys]) {
    const value = source[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.DISABLE_AUTOUPDATER = '1';

  return toProcessEnv({ ...env, ...overrides });
};
