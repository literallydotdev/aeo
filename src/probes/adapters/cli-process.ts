import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  isWorkerInvocationError,
  type WorkerTransport,
} from '../../container/protocol';
import type { AeoAgentSurface, RetrievalLog } from '../../schema';
import type { ProbeAdapterProfile } from '../adapter';
import { isRecord } from '../../lib/type-guards';
import {
  codexArgs,
  resolveCodexBinary,
} from '../../codex-workflow/codex-binary';
import {
  AgentStreamError,
  RejectedWebToolError,
  RetrievalConsistencyError,
} from '../agent-cli-parsers';
import { ChildProcessError, runChild } from '../child-process';
import {
  errorMessage,
  isAuthError,
  isCapacityError,
  ProbeFailure,
  type ProbeFailureKind,
} from '../failure';

// ============================================================================
// What every coding-agent CLI adapter shares (specs/aeo-probe-adapters-spec.md
// §4.10): how a CLI is started on this machine (a scratch directory, an
// allowlisted environment, a deadline and an output cap) and how its
// failure is read and classified. The per-CLI invocations live in
// cli-claude-code.ts, cli-codex.ts and cli-cursor.ts.
// ============================================================================

/** authSettingNames is the variables a CLI may authenticate with, any one
 * of which is enough: what preflight accepts and what the CLI's child
 * environment is allowed to carry. */
export const authSettingNames = (profile: ProbeAdapterProfile): string[] => {
  return profile.settings
    .filter((setting) => setting.group === 'auth')
    .map((setting) => setting.name);
};

export const agentProbeTimeoutMs = 5 * 60 * 1000;
const agentKillGraceMs = 10_000;
// Verbose streams (stream-json) are several times the size of the old
// single-JSON output.
const agentMaxBufferBytes = 64 * 1024 * 1024;

// How the CLIs are launched (hardening spec §4.5): the environment the
// allowlist is built from and, for Claude Code, where its config lives.
export type AgentRuntime = {
  env: NodeJS.ProcessEnv;
  // A per-run directory for CLAUDE_CONFIG_DIR when auth is provisioned by
  // variable (a token or API key): transcripts then die with the run. Null
  // keeps the operator's logged-in config and deletes the probe's
  // transcript directory after each probe instead (§2.8).
  claudeConfigDir: string | null;
  timeoutMs?: number;
  // The isolated worker the CLIs run in, in the hosted platform. Absent, a
  // CLI runs on this machine. Passed in, never read from a global slot.
  transport?: WorkerTransport;
};

/** What one CLI run answered, as the parsers or a worker report it. */
export type AgentAnswer = {
  text: string;
  usedWebSearch: boolean | null;
  retrieval: RetrievalLog;
  requestedModel?: string | null;
  reportedModel?: string;
};

export type AgentProbeFn = (
  promptText: string,
  runtime: AgentRuntime,
  signal?: AbortSignal,
) => Promise<AgentAnswer>;

/** What to spawn for an agent CLI on this machine. Codex is this package's
 * own pinned dependency (specs/aeo-claude-operator-spec.md §4.3), run with
 * the operator's Codex login when it is measured, unless the runtime's
 * AEO_CODEX_BIN names another; the others come from PATH. */
export const localCommand = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } => {
  if (command !== 'codex') {
    return { command, args: [...args] };
  }

  const binary = resolveCodexBinary(env);

  return { command: binary.command, args: codexArgs(binary, args) };
};

// ---------------------------------------------------------------------------
// Failure classification and reporting
// ---------------------------------------------------------------------------

export type AgentFailure = {
  kind: ProbeFailureKind;
  // Never contains the prompt: the child runner's messages name the command
  // and the exit state, and the detail comes from the CLI's own output.
  message: string;
};

type CliOutput = { stdout: string; stderr: string };

// Parser errors carry the CLI output they were raised over, so the failure
// line can quote the CLI's own account (a stream that ended in an API error
// message, say) without the classifier ever reading answer text. The output
// is kept beside the error rather than written onto it.
const cliOutputByError = new WeakMap<object, CliOutput>();

export const attachCliOutput = (error: unknown, output: CliOutput): unknown => {
  if (typeof error === 'object' && error !== null) {
    cliOutputByError.set(error, output);
  }

  return error;
};

const workerFailureKinds = new Map<string, ProbeFailureKind>([
  ['capacity', 'capacity'],
  ['auth', 'auth'],
  ['timeout', 'timeout'],
  ['parser', 'parser'],
  ['rejected_web_tool', 'rejected_web_tool'],
]);

export const classifyAgentError = (error: unknown): AgentFailure => {
  if (error instanceof ProbeFailure) {
    return { kind: error.kind, message: error.message };
  }

  if (isWorkerInvocationError(error)) {
    const kind = workerFailureKinds.get(error.kind) ?? 'cli_error';

    return { kind, message: error.detail ?? error.message };
  }

  if (error instanceof RejectedWebToolError) {
    return { kind: 'rejected_web_tool', message: error.message };
  }

  if (error instanceof RetrievalConsistencyError) {
    return { kind: 'parser', message: error.message };
  }

  if (error instanceof ChildProcessError) {
    const { result } = error;

    if (result.timedOut || result.aborted) {
      return { kind: 'timeout', message: error.message };
    }

    const signals = cliFailureSignals(result);

    return {
      kind: kindFromSignals(signals.errorTexts, 'cli_error'),
      message: signals.detail
        ? `${error.message} — ${signals.detail}`
        : error.message,
    };
  }

  if (error instanceof AgentStreamError) {
    const output = cliOutputByError.get(error);
    const signals = output
      ? cliFailureSignals({ code: 0, signal: null, ...output })
      : { detail: '', errorTexts: [] };

    return {
      kind:
        error.kind === 'cli_error'
          ? kindFromSignals(signals.errorTexts, 'cli_error')
          : 'parser',
      message: signals.detail
        ? `${error.message} — ${signals.detail}`
        : error.message,
    };
  }

  const message = errorMessage(error);

  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'timeout', message };
  }

  return { kind: 'cli_error', message };
};

const kindFromSignals = (
  errorTexts: readonly string[],
  fallback: ProbeFailureKind,
): ProbeFailureKind => {
  const joined = errorTexts.join('\n');

  if (isCapacityError(joined)) {
    return 'capacity';
  }

  if (isAuthError(joined)) {
    return 'auth';
  }

  return fallback;
};

const cliFailureDetailChars = 300;

export type CliFailureSignals = {
  // The most useful line about the failure, for the log.
  detail: string;
  // Texts the classifier may read: stderr and the messages of events that
  // the CLI itself marked as errors. Never a plain assistant text block.
  errorTexts: string[];
};

const describeExit = ({
  code,
  signal,
}: {
  code: number | null;
  signal?: NodeJS.Signals | null;
}): string => {
  if (typeof code === 'number') {
    return `exit ${code}`;
  }

  if (signal) {
    return `killed by ${signal}`;
  }

  return '';
};

/**
 * What the CLI said about its own failure: the last event it marked as an
 * error, otherwise stderr when it wrote anything, otherwise the last message
 * in its NDJSON stdout (the `result`, an error string, or the last text
 * block), otherwise the raw stdout tail. Error events come before stderr
 * because Codex always writes a stdin notice there, even when the real error
 * is a structured event.
 */
export const cliFailureSignals = (output: {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}): CliFailureSignals => {
  const exit = describeExit(output);
  const stderrText = output.stderr.trim();
  const errorTexts: string[] = [];
  let lastErrorEventText: string | null = null;

  if (stderrText) {
    errorTexts.push(stderrText);
  }

  const events = parseEventLines(output.stdout);

  for (const event of events) {
    if (!isErrorEvent(event)) {
      continue;
    }

    const text = eventMessage(event);

    if (text) {
      errorTexts.push(text);
      lastErrorEventText = text;
    }

    if (typeof event.error === 'string') {
      errorTexts.push(event.error);
    }
  }

  let detail: string;

  if (lastErrorEventText) {
    detail = `error event: ${lastErrorEventText.slice(0, cliFailureDetailChars)}`;
  } else if (stderrText) {
    detail = `stderr: ${stderrText.slice(0, cliFailureDetailChars)}`;
  } else {
    const last = lastCliMessage(events, output.stdout);
    detail = last ? `last stdout message: ${last}` : '';
  }

  return {
    detail: [exit, detail].filter(Boolean).join(', '),
    errorTexts,
  };
};

/** Log line for a failed CLI run; empty when there is nothing to say. */
export const describeCliFailure = (output: {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}): string => {
  return cliFailureSignals(output).detail;
};

const parseEventLines = (stdout: string): Record<string, unknown>[] => {
  const events: Record<string, unknown>[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed.startsWith('{')) {
      continue;
    }

    try {
      const event: unknown = JSON.parse(trimmed);

      if (isRecord(event)) {
        events.push(event);
      }
    } catch {
      continue;
    }
  }

  return events;
};

// An event the CLI marked as an error: Claude Code's `error` field on an
// assistant turn, an `is_error` result, an error subtype, Codex's top-level
// `error` event, `turn.failed` or item with `error`, a Cursor
// `subtype: 'error'`.
const isErrorEvent = (event: Record<string, unknown>): boolean => {
  if (event.type === 'error') {
    return true;
  }

  if (typeof event.error === 'string' || isRecord(event.error)) {
    return true;
  }

  if (event.is_error === true) {
    return true;
  }

  if (typeof event.subtype === 'string' && /error/i.test(event.subtype)) {
    return true;
  }

  const item = isRecord(event.item) ? event.item : null;

  if (item && (item.error !== undefined || item.status === 'failed')) {
    return true;
  }

  return false;
};

// Newest-first scan of the NDJSON events for the first one carrying a
// human-readable message; falls back to the raw tail of the output.
const lastCliMessage = (
  events: readonly Record<string, unknown>[],
  stdout: string,
): string => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];

    if (!event) {
      continue;
    }

    const text = eventMessage(event);

    if (text) {
      return text.slice(0, cliFailureDetailChars);
    }
  }

  return stdout.trim().slice(-cliFailureDetailChars);
};

// Readable text first (the final `result`, a text block, an agent message);
// a bare error code like Claude Code's `error: "server_error"` is the last
// resort, since the same event carries the full message as a text block.
const eventMessage = (event: Record<string, unknown>): string | null => {
  const candidates: unknown[] = [event.result];
  const message = isRecord(event.message) ? event.message : null;

  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (isRecord(block) && typeof block.text === 'string') {
        candidates.push(block.text);
      }
    }
  }

  if (isRecord(event.item)) {
    candidates.push(event.item.text);
  }

  if (isRecord(event.msg)) {
    candidates.push(event.msg.message);
  }

  // Codex: `{type: 'error', message}` and `{type: 'turn.failed', error: {message}}`.
  candidates.push(event.message);

  if (isRecord(event.error)) {
    candidates.push(event.error.message);
  }

  candidates.push(event.error);

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return unwrapApiErrorBody(candidate.trim());
    }
  }

  return null;
};

// Codex relays the API's error body as JSON text inside its own message. The
// readable part is the body's `error.message`; the HTTP status stays with it
// so the auth and capacity patterns still match.
const unwrapApiErrorBody = (text: string): string => {
  if (!text.startsWith('{')) {
    return text;
  }

  try {
    const body: unknown = JSON.parse(text);

    if (
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === 'string'
    ) {
      return typeof body.status === 'number'
        ? `HTTP ${body.status}: ${body.error.message}`
        : body.error.message;
    }
  } catch {
    // Text that only looks like JSON stands as written.
  }

  return text;
};

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

/**
 * Creates an empty scratch directory so the agent sees no repo context, and
 * removes it afterwards. Claude Code also writes its session transcript
 * under `<config dir>/projects/<cwd slug>/` regardless of the scratch dir
 * (hardening spec §2.8): with the operator's own config dir in use, that
 * transcript — client prompt and answer — is deleted in the same finally.
 */
export const withScratchDir = async <T>(
  runtime: AgentRuntime,
  surface: AeoAgentSurface,
  fn: (dir: string) => Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aeo-agent-probe-'));

  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });

    if (surface === 'claude_code' && !runtime.claudeConfigDir) {
      await rm(claudeTranscriptDir(runtime.env, dir), {
        recursive: true,
        force: true,
      });
    }
  }
};

/** Where Claude Code keeps the transcript of a session run in `cwd`. */
export const claudeTranscriptDir = (
  env: NodeJS.ProcessEnv,
  cwd: string,
): string => {
  const configDir =
    env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? homedir(), '.claude');

  return path.join(configDir, 'projects', cwd.replaceAll('/', '-'));
};

type ExecCliOptions = {
  cliArgs: string[];
  cwd: string;
  runtime: AgentRuntime;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export const execCli = async (
  command: string,
  { cliArgs, cwd, runtime, env, signal }: ExecCliOptions,
): Promise<CliOutput> => {
  const local = localCommand(command, cliArgs, runtime.env);
  const result = await runChild(local.command, local.args, {
    cwd,
    env,
    timeoutMs: runtime.timeoutMs ?? agentProbeTimeoutMs,
    maxBuffer: agentMaxBufferBytes,
    killGraceMs: agentKillGraceMs,
    signal,
  });

  return { stdout: result.stdout, stderr: result.stderr };
};
