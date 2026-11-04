import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  requireWorkerTransport,
  workerTransport,
  isWorkerInvocationError,
} from '../container/protocol';
import type { AeoAgentSurface, RetrievalLog } from '../schema';
import { agentSurfaces, surfaceRunCounts, retrievalLogSchema } from '../schema';
import { createLog } from '../lib/log';
import { isRecord } from '../lib/type-guards';
import { getEnvironment, readEnv } from '../lib/env';
import { codexArgs, resolveCodexBinary } from '../codex-workflow/codex-binary';
import type { ProbePromptInput, ProbeResult } from './probes';
import {
  AgentStreamError,
  RejectedWebToolError,
  RetrievalConsistencyError,
  parseClaudeCodeStream,
  parseCodexEvents,
  parseCursorStream,
} from './agent-cli-parsers';
import { ChildProcessError, childEnv, runChild } from './child-process';
import {
  agentProbeRetryPolicy,
  errorMessage,
  isAuthError,
  isCapacityError,
  ProbeFailure,
  retryDelayMs,
  type ProbeFailureKind,
} from './failure';
import { sleep, unlimited, type ProbeLimiter } from './limits';
import type { ProbeOutcome, ProbeUnitRef } from './outcomes';
import {
  endAttempt,
  ProbeTraceError,
  startAttempt,
  type ProbeAttemptHandle,
  type ProbeTrace,
} from './probe-trace';

const execFileAsync = promisify(execFile);
const log = createLog('AgentCliProbes');

// ±20% so units that failed together do not all retry in the same second.
const retryJitterRatio = 0.2;

const addJitter = (delayMs: number): number => {
  const factor = 1 - retryJitterRatio + Math.random() * 2 * retryJitterRatio;

  return Math.round(delayMs * factor);
};

// ============================================================================
// Agent-surface probes (spec §5): what an agentic coding assistant tells a
// developer who asks it what to adopt — the real product experience, not a
// raw model call. Headless CLI runs, web tools enabled, executed in an empty
// scratch directory (no repo context, no CLAUDE.md).
// ============================================================================
// Each result records whether web tools were actually used (`usedWebSearch`,
// tri-state — see agent-cli-parsers.ts for the one definition) and the
// retrieval log behind the answer (every search and fetch, with result
// sets where the CLI exposes them — retrieval-log spec §5.1), both read
// from the CLI's structured tool events, never from the answer text. A CLI that
// REJECTS a web tool call is a runner misconfiguration: the probe fails
// loudly (RejectedWebToolError) instead of recording a from-memory answer
// (correctness spec §3.1).
//
// Every planned unit ends in exactly one outcome (hardening spec §4.1): a
// captured probe, or a typed failure after the retry policy in failure.ts
// is spent. Capacity failures (Anthropic 529s behind Claude Code, Cursor's
// resource_exhausted) are read from stderr and structured error events
// only — never from an answer that happens to mention rate limiting — and
// wait out the long ladder with the worker's pool slot released.

const agentProbeTimeoutMs = 5 * 60 * 1000;
const agentKillGraceMs = 10_000;
// Verbose streams (stream-json) are several times the size of the old
// single-JSON output.
const agentMaxBufferBytes = 64 * 1024 * 1024;

export type AgentProbeResult = {
  modelName: AeoAgentSurface;
  usedWebSearch: boolean | null;
  agentCliVersion: string;
  // The model the probe asked the CLI for, when the run pins one
  // (`AEO_CODEX_PROBE_MODEL`); null means the CLI's own default answered.
  requestedModel?: string | null;
  // Always set on a fresh probe (the parsers record every web call); the
  // inherited optional stays because checkpointed probes from before the
  // retrieval-log spec carry none.
  retrieval?: RetrievalLog;
} & ProbeResult;

export type AgentCliVersions = {
  claudeCode: string | null;
  codex: string | null;
  cursor: string | null;
};

export type AgentProbeOutcome = ProbeOutcome<AgentProbeResult>;

export type AgentProbeBatch = {
  outcomes: AgentProbeOutcome[];
  // Surfaces where EVERY unit failed on a rejected web tool call: retrying
  // cannot fix a configuration problem, so the run reports it once.
  rejectedWebToolSurfaces: AeoAgentSurface[];
};

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
};

export const defaultAgentRuntime = (
  env: NodeJS.ProcessEnv = getEnvironment(),
): AgentRuntime => {
  return { env, claudeConfigDir: null };
};

/** Detects which agent CLIs are installed and their versions. */
export const detectAgentClis = async (): Promise<AgentCliVersions> => {
  return {
    claudeCode: await cliVersion('claude', ['--version']),
    codex: await cliVersion('codex', ['--version']),
    cursor: await cliVersion('cursor-agent', ['--version']),
  };
};

export const versionForSurface = (
  surface: AeoAgentSurface,
  versions: AgentCliVersions,
): string | null => {
  switch (surface) {
    case 'claude_code':
      return versions.claudeCode;
    case 'codex':
      return versions.codex;
    case 'cursor':
      return versions.cursor;
  }
};

/**
 * Pre-flight (correctness spec §3.6): every agent surface in scope needs its
 * CLI installed before a single probe is sent — same fail-fast posture as
 * assertEnvVars. Throws ONE error listing every missing CLI; the escape
 * hatch is --surfaces.
 */
export const assertAgentClis = (
  surfaces: readonly AeoAgentSurface[],
  versions: AgentCliVersions,
): void => {
  const missing = surfaces.filter((s) => !versionForSurface(s, versions));

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    [
      `Missing agent CLI${missing.length === 1 ? '' : 's'} for surface${
        missing.length === 1 ? '' : 's'
      } in scope:`,
      ...missing.map(
        (s) => `  - ${s} — \`${cliNameForSurface(s)}\` not found on PATH`,
      ),
      'Install and authenticate the CLI, or narrow the run with --surfaces to',
      'leave the surface out (the snapshot then records it as unmeasured).',
    ].join('\n'),
  );
};

// Headless auth (hardening spec §3.3, §4.5): the CLIs' interactive login
// does not exist in a container, so a non-interactive run must carry auth
// by variable. Any one of a surface's alternatives satisfies it.
export const agentAuthEnv: Readonly<
  Record<AeoAgentSurface, { anyOf: readonly string[]; purpose: string }>
> = {
  claude_code: {
    anyOf: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    purpose:
      'Claude Code probes (subscription token from `claude setup-token`, or an API key)',
  },
  codex: {
    anyOf: ['OPENAI_API_KEY', 'CODEX_HOME'],
    purpose:
      'Codex probes (an API key, or a CODEX_HOME provisioned with `codex login --with-api-key`)',
  },
  cursor: {
    anyOf: ['CURSOR_API_KEY'],
    purpose: 'Cursor probes',
  },
};

export const assertAgentAuth = (
  surfaces: readonly AeoAgentSurface[],
  env: NodeJS.ProcessEnv,
): void => {
  const transport = workerTransport();

  if (readEnv('AEO_ISOLATED_ADAPTER') === '1' && !transport) {
    requireWorkerTransport();
  }

  const missing = surfaces.filter((surface) =>
    transport
      ? !transport.has(surface)
      : !agentAuthEnv[surface].anyOf.some((name) => env[name]),
  );

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    [
      'Non-interactive run: agent CLI auth must be provided by environment for every agent surface in scope:',
      ...missing.map(
        (surface) =>
          `  - ${surface} — one of ${agentAuthEnv[surface].anyOf.join(', ')} (${agentAuthEnv[surface].purpose})`,
      ),
      'Set them, or narrow the run with --surfaces.',
    ].join('\n'),
  );
};

/** The CLI binary behind a surface, for pre-flight messages. */
export const cliNameForSurface = (surface: AeoAgentSurface): string => {
  switch (surface) {
    case 'claude_code':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'cursor':
      return 'cursor-agent';
  }
};

// What a worker sends back for a probe or a version request.
const agentAnswerSchema = z.object({
  text: z.string(),
  usedWebSearch: z.boolean().nullable(),
  retrieval: retrievalLogSchema,
  requestedModel: z.string().nullable().optional(),
  reportedModel: z.string().optional(),
});

const workerVersionSchema = z.string().nullish();

type AgentAnswer = {
  text: string;
  usedWebSearch: boolean | null;
  retrieval: RetrievalLog;
  requestedModel?: string | null;
  reportedModel?: string;
};

const getVersionSurface = (command: string): AeoAgentSurface => {
  if (command === 'claude') {
    return 'claude_code';
  }

  if (command === 'codex') {
    return 'codex';
  }

  return 'cursor';
};

type AgentProbeFn = (
  promptText: string,
  runtime: AgentRuntime,
  signal?: AbortSignal,
) => Promise<AgentAnswer>;

const probeForSurface = (surface: AeoAgentSurface): AgentProbeFn => {
  const transport = workerTransport();

  if (transport) {
    return async (prompt, runtime, signal) => {
      const answer = await transport.invoke(
        surface,
        {
          task: 'probe',
          prompt,
          timeoutMs: Math.min(
            runtime.timeoutMs ?? agentProbeTimeoutMs,
            300_000,
          ),
        },
        signal,
      );

      return agentAnswerSchema.parse(answer);
    };
  }

  if (readEnv('AEO_ISOLATED_ADAPTER') === '1') {
    requireWorkerTransport();
  }

  switch (surface) {
    case 'claude_code':
      return runClaudeCodeProbe;
    case 'codex':
      return runCodexProbe;
    case 'cursor':
      return runCursorProbe;
  }
};

/** What to spawn for an agent CLI on this machine. Codex is this package's
 * own pinned dependency (specs/aeo-claude-operator-spec.md §4.3), run with
 * the operator's Codex login when it is measured; the others come from
 * PATH. */
const localCommand = (
  command: string,
  args: readonly string[],
): { command: string; args: string[] } => {
  if (command !== 'codex') {
    return { command, args: [...args] };
  }

  const binary = resolveCodexBinary();

  return { command: binary.command, args: codexArgs(binary, args) };
};

const cliVersion = async (
  command: string,
  args: string[],
): Promise<string | null> => {
  try {
    const transport = workerTransport();

    if (transport) {
      const version = await transport.invoke(getVersionSurface(command), {
        task: 'version',
      });

      return workerVersionSchema.parse(version) ?? null;
    }

    if (readEnv('AEO_ISOLATED_ADAPTER') === '1') {
      requireWorkerTransport();
    }

    const local = localCommand(command, args);
    const { stdout } = await execFileAsync(local.command, local.args, {
      timeout: 15_000,
    });

    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
};

export const canaryPrompt =
  'Reply with the single word OK and nothing else. Do not search the web.';

/**
 * Canary pre-flight (§4.5): one cheap probe per agent surface in scope, so
 * a container that passes the install check but cannot authenticate fails
 * before the batch instead of producing an all-failed surface.
 */
export type CanaryFailure = AgentFailure & { surface: AeoAgentSurface };

export type CanaryOptions = {
  signal?: AbortSignal;
  /** The run journal: each canary attempt is a preflight operation. */
  trace?: ProbeTrace;
};

/** One surface's canary: null when it answered, otherwise why it could not. */
export const runCanaryProbe = async (
  surface: AeoAgentSurface,
  runtime: AgentRuntime,
  { signal, trace }: CanaryOptions = {},
): Promise<CanaryFailure | null> => {
  const startedAt = Date.now();
  let traced: ProbeAttemptHandle | undefined;

  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();

    const retryOf = traced?.id;

    // A canary is a preflight operation (spec §4.2): recorded like a probe,
    // before the CLI starts, since it may cost something.
    traced = await startAttempt(trace, {
      surface,
      promptId: 'canary',
      promptText: canaryPrompt,
      runIndex: 0,
      attempt,
      ...(retryOf === undefined ? {} : { retryOf }),
      requestedModel: null,
    });

    try {
      const answer = await probeForSurface(surface)(
        canaryPrompt,
        {
          ...runtime,
          timeoutMs: Math.min(runtime.timeoutMs ?? 120_000, 120_000),
        },
        signal,
      );

      log.info('Canary probe passed', {
        surface,
        durationMs: Date.now() - startedAt,
        chars: answer.text.length,
      });

      const unrecorded = await endAttempt(traced, {
        outcome: 'succeeded',
        text: answer.text,
        retrieval: answer.retrieval,
        requestedModel: answer.requestedModel ?? null,
        ...(answer.reportedModel
          ? { reportedModel: answer.reportedModel }
          : {}),
      });

      return unrecorded === null
        ? null
        : { kind: 'persistence', message: unrecorded, surface };
    } catch (error) {
      const failure = classifyAgentError(error);
      const unrecorded = await endAttempt(traced, {
        outcome: signal?.aborted ? 'cancelled' : 'failed',
        kind: failure.kind,
        error: failure.message,
      });

      signal?.throwIfAborted();

      if (unrecorded !== null) {
        return { kind: 'persistence', message: unrecorded, surface };
      }

      const delay = retryDelayMs(failure.kind, attempt);

      if (delay !== null) {
        await sleep(delay, signal);
        continue;
      }

      log.error('Canary probe failed', error, {
        surface,
        kind: failure.kind,
        detail: failure.message,
      });

      return { ...failure, surface };
    }
  }
};

export const runCanaryProbes = async (
  surfaces: readonly AeoAgentSurface[],
  runtime: AgentRuntime,
  options: CanaryOptions = {},
): Promise<void> => {
  const failures = (
    await Promise.all(
      surfaces.map((surface) => runCanaryProbe(surface, runtime, options)),
    )
  ).filter((failure) => failure !== null);

  const [firstFailure] = failures;

  if (firstFailure) {
    // A permanent failure takes precedence over capacity in a multi-surface canary.
    const kind =
      failures.find((failure) =>
        ['auth', 'rejected_web_tool'].includes(failure.kind),
      )?.kind ?? firstFailure.kind;

    throw new ProbeFailure(
      kind,
      [
        'Agent canary probe failed; the CLI is installed but cannot answer (auth, network, or configuration):',
        ...failures
          .map(
            ({ surface, kind, message }) =>
              `  - ${surface}: ${kind} — ${message}`,
          )
          .sort(),
      ].join('\n'),
    );
  }
};

type AgentProbeSpec = {
  surface: AeoAgentSurface;
  prompt: ProbePromptInput;
  runIndex: number;
};

/**
 * Runs every agent probe (prompt × agent surface × run) through the
 * per-CLI pools, returning one outcome per unit. A surface whose CLI is
 * missing is a hard error here — the runner's pre-flight (§3.6) rejects it
 * before any probe is sent; reaching this point without a version is a bug.
 */
export const runAgentProbesForPrompts = async (args: {
  prompts: ProbePromptInput[];
  surfaces?: readonly AeoAgentSurface[];
  versions: AgentCliVersions;
  // Runs per prompt per surface — defaults to the canonical surfaceRunCounts
  // value; report configs may lower it to shrink the agent batch (spec §5,
  // revised 2026-08-21).
  runsPerPrompt?: number;
  // Unit-level gate for store resume: return false to skip a planned
  // (prompt × surface × run) execution. Omitted = run everything.
  filter?: (unit: {
    promptId: string;
    surface: AeoAgentSurface;
    runIndex: number;
  }) => boolean;
  // Called with each captured probe as it completes, so the caller can bank
  // it before the (hour-long) batch ends. A throwing banker turns the unit
  // into a `persistence` failure; the probe is never re-executed (§4.2).
  onResult?: (result: AgentProbeResult) => Promise<void>;
  // The run journal: each attempt is an operation (probe-trace.ts).
  trace?: ProbeTrace;
  limiter?: ProbeLimiter;
  runtime?: AgentRuntime;
  signal?: AbortSignal;
  logContext?: Record<string, unknown>;
}): Promise<AgentProbeBatch> => {
  const surfaces = args.surfaces ?? agentSurfaces;
  const limiter = args.limiter ?? unlimited();
  const runtime = args.runtime ?? defaultAgentRuntime();

  const specs: AgentProbeSpec[] = [];

  for (const prompt of args.prompts) {
    for (const surface of surfaces) {
      if (!versionForSurface(surface, args.versions)) {
        throw new Error(
          `Agent CLI for ${surface} (${cliNameForSurface(surface)}) is not installed; the pre-flight check should have rejected this run.`,
        );
      }

      const runs = args.runsPerPrompt ?? surfaceRunCounts[surface];

      for (let run = 1; run <= runs; run++) {
        if (
          args.filter &&
          !args.filter({ promptId: prompt.id, surface, runIndex: run })
        ) {
          continue;
        }

        specs.push({ surface, prompt, runIndex: run });
      }
    }
  }

  const outcomes = await Promise.all(
    specs.map((spec) =>
      runAgentUnit(spec, {
        version: versionForSurface(spec.surface, args.versions) ?? 'unknown',
        limiter,
        runtime,
        signal: args.signal,
        onResult: args.onResult,
        trace: args.trace,
        logContext: args.logContext,
      }),
    ),
  );

  const rejectedWebToolSurfaces = surfaces.filter((surface) => {
    const onSurface = outcomes.filter((o) => o.unit.surface === surface);

    return (
      onSurface.length > 0 &&
      onSurface.every(
        (o) => o.status === 'failed' && o.kind === 'rejected_web_tool',
      )
    );
  });

  const captured = outcomes.filter((o) => o.status === 'captured').length;
  log.info('Agent probes completed', {
    ...args.logContext,
    planned: specs.length,
    captured,
    failed: specs.length - captured,
    ...(rejectedWebToolSurfaces.length > 0 ? { rejectedWebToolSurfaces } : {}),
  });

  return { outcomes, rejectedWebToolSurfaces };
};

const runAgentUnit = async (
  spec: AgentProbeSpec,
  ctx: {
    version: string;
    limiter: ProbeLimiter;
    runtime: AgentRuntime;
    signal?: AbortSignal;
    onResult?: (result: AgentProbeResult) => Promise<void>;
    trace?: ProbeTrace;
    logContext?: Record<string, unknown>;
  },
): Promise<AgentProbeOutcome> => {
  const unit: ProbeUnitRef = {
    promptId: spec.prompt.id,
    surface: spec.surface,
    runIndex: spec.runIndex,
  };

  const context = {
    ...ctx.logContext,
    surface: spec.surface,
    promptId: spec.prompt.id,
    run: spec.runIndex,
  };

  const probe = probeForSurface(spec.surface);

  let attempt = 0;
  let answer: AgentAnswer | null = null;
  let traced: ProbeAttemptHandle | undefined;

  for (;;) {
    if (ctx.signal?.aborted) {
      return {
        status: 'failed',
        unit,
        kind: 'timeout',
        attempts: attempt,
        lastError: 'run aborted before the unit executed',
      };
    }

    attempt += 1;
    const probeStartedAt = Date.now();
    const retryOf = traced?.id;

    traced = undefined;

    try {
      // The pool slot is held for one attempt only, so a capacity wait
      // below never blocks another unit on the same CLI. The operation
      // opens inside it, before the CLI starts.
      answer = await ctx.limiter.run(
        spec.surface,
        async () => {
          traced = await startAttempt(ctx.trace, {
            surface: spec.surface,
            promptId: spec.prompt.id,
            promptText: spec.prompt.promptText,
            runIndex: spec.runIndex,
            attempt,
            ...(retryOf === undefined ? {} : { retryOf }),
            // Known from the CLI's answer; recorded when the attempt ends.
            requestedModel: null,
          });

          return probe(spec.prompt.promptText, ctx.runtime, ctx.signal);
        },
        { signal: ctx.signal },
      );

      log.info('Agent probe completed', {
        ...context,
        attempt,
        usedWebSearch: answer.usedWebSearch,
        retrievalCalls: answer.retrieval.calls.length,
        durationMs: Date.now() - probeStartedAt,
        chars: answer.text.length,
      });

      break;
    } catch (error) {
      if (error instanceof ProbeTraceError) {
        return {
          status: 'failed',
          unit,
          kind: 'persistence',
          attempts: attempt,
          lastError: error.message,
        };
      }

      const failure = classifyAgentError(error);
      const unrecorded = await endAttempt(traced, {
        outcome: ctx.signal?.aborted ? 'cancelled' : 'failed',
        kind: failure.kind,
        error: failure.message,
      });

      if (unrecorded !== null) {
        return {
          status: 'failed',
          unit,
          kind: 'persistence',
          attempts: attempt,
          lastError: unrecorded,
        };
      }

      const ladderDelayMs = retryDelayMs(
        failure.kind,
        attempt,
        agentProbeRetryPolicy,
      );
      const delayMs = ladderDelayMs === null ? null : addJitter(ladderDelayMs);

      log.warn(
        delayMs === null
          ? 'Agent probe failed'
          : 'Agent probe failed; retrying',
        {
          ...context,
          attempt,
          kind: failure.kind,
          ...(delayMs === null ? {} : { retryInMs: delayMs }),
          durationMs: Date.now() - probeStartedAt,
          error: failure.message,
        },
      );

      if (delayMs === null) {
        return {
          status: 'failed',
          unit,
          kind: failure.kind,
          attempts: attempt,
          lastError: failure.message,
        };
      }

      // The whole surface waits the window out, not only this unit.
      if (failure.kind === 'capacity') {
        ctx.limiter.pause(spec.surface, delayMs);
      }

      await sleep(delayMs, ctx.signal);
    }
  }

  // The text the bank keeps, so the operation's answer is the capture.
  const text = answer.text.replaceAll('\u0000', '');
  const unrecorded = await endAttempt(traced, {
    outcome: 'succeeded',
    text,
    retrieval: answer.retrieval,
    requestedModel: answer.requestedModel ?? null,
    ...(answer.reportedModel ? { reportedModel: answer.reportedModel } : {}),
  });

  if (unrecorded !== null) {
    return {
      status: 'failed',
      unit,
      kind: 'persistence',
      attempts: attempt,
      lastError: unrecorded,
    };
  }

  const result: AgentProbeResult = {
    promptId: spec.prompt.id,
    promptText: spec.prompt.promptText,
    promptCategory: spec.prompt.category,
    modelName: spec.surface,
    runIndex: spec.runIndex,
    text,
    usedWebSearch: answer.usedWebSearch,
    agentCliVersion: ctx.version,
    retrieval: answer.retrieval,
    requestedModel: answer.requestedModel ?? null,
    ...(answer.reportedModel ? { reportedModel: answer.reportedModel } : {}),
  };

  // Banking sits outside the attempt loop (§4.2): a writer that throws must
  // never re-run a paid probe.
  try {
    await ctx.onResult?.(result);
  } catch (error) {
    log.error(
      'Agent probe captured but could not be persisted',
      error,
      context,
    );

    return {
      status: 'failed',
      unit,
      kind: 'persistence',
      attempts: attempt,
      lastError: errorMessage(error),
    };
  }

  return { status: 'captured', unit, probe: result, attempts: attempt };
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

const attachCliOutput = (error: unknown, output: CliOutput): unknown => {
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
const withScratchDir = async <T>(
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

// Per-CLI environment allowlist (§4.5): the one auth variable each CLI
// needs, nothing else from the parent.
const claudeEnvKeys = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
];

const codexEnvKeys = ['OPENAI_API_KEY', 'CODEX_HOME'];
const cursorEnvKeys = ['CURSOR_API_KEY'];

type ExecCliOptions = {
  cliArgs: string[];
  cwd: string;
  runtime: AgentRuntime;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

const execCli = async (
  command: string,
  { cliArgs, cwd, runtime, env, signal }: ExecCliOptions,
): Promise<CliOutput> => {
  const local = localCommand(command, cliArgs);
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

const runClaudeCodeProbe: AgentProbeFn = async (
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

const runCodexProbe: AgentProbeFn = async (promptText, runtime, signal) => {
  return withScratchDir(runtime, 'codex', async (dir) => {
    const lastMessagePath = path.join(dir, 'last-message.txt');
    const requestedModel = codexProbeModel(runtime.env);
    const output = await execCli('codex', {
      cliArgs: [
        'exec',
        '--json',
        ...(requestedModel ? ['--model', requestedModel] : []),
        '--sandbox',
        readEnv('AEO_CODEX_SANDBOX') === 'danger-full-access'
          ? 'danger-full-access'
          : 'read-only',
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

const runCursorProbe: AgentProbeFn = async (promptText, runtime, signal) => {
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

/** Called only inside a fixed isolated worker, or by the local CLI path. */
export const runAgentProbeDirect = async (
  surface: AeoAgentSurface,
  {
    prompt,
    runtime,
    signal,
  }: { prompt: string; runtime: AgentRuntime; signal?: AbortSignal },
): Promise<AgentAnswer> => {
  if (readEnv('AEO_ISOLATED_ADAPTER') === '1') {
    throw new Error('Direct CLI launch prohibited in adapter.');
  }

  return probeForSurface(surface)(prompt, runtime, signal);
};
