import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AeoAgentSurface, RetrievalLog } from '../schema';
import { agentSurfaces, surfaceRunCounts } from '../schema';
import { createLog } from '../lib/log';
import { getEnvironment, readEnv } from '../lib/env';
import {
  createCliAdapter,
  cliAdapterProfiles,
  probeForSurface,
} from './adapters/cli-agents';
import {
  authSettingNames,
  localCommand,
  type AgentAnswer,
  type AgentFailure,
  type AgentRuntime,
} from './adapters/cli-process';
import {
  attemptRules,
  reportedModelOf,
  requestedModelOf,
  runProbeAttempts,
  runProbeUnit,
} from './attempt';
import type { ProbePromptInput, ProbeResult } from './probes';
import { ProbeFailure } from './failure';
import { unlimited, type ProbeLimiter } from './limits';
import type { ProbeOutcome } from './outcomes';
import { endAttempt, ProbeTraceError, type ProbeTrace } from './probe-trace';

export type {
  AgentAnswer,
  AgentFailure,
  AgentRuntime,
  CliFailureSignals,
} from './adapters/cli-process';
export {
  classifyAgentError,
  claudeTranscriptDir,
  cliFailureSignals,
  describeCliFailure,
} from './adapters/cli-process';

const execFileAsync = promisify(execFile);
const log = createLog('AgentCliProbes');

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

export const defaultAgentRuntime = (
  env: NodeJS.ProcessEnv = getEnvironment(),
): AgentRuntime => {
  return { env, claudeConfigDir: null };
};

/** Detects which agent CLIs the runtime can start, and their versions:
 * through its worker transport when it has one, else on this machine. */
export const detectAgentClis = async (
  runtime: AgentRuntime = defaultAgentRuntime(),
): Promise<AgentCliVersions> => {
  return {
    claudeCode: await cliVersion('claude', ['--version'], runtime),
    codex: await cliVersion('codex', ['--version'], runtime),
    cursor: await cliVersion('cursor-agent', ['--version'], runtime),
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
// by variable. Any one of a surface's alternatives satisfies it; the names
// are the CLI adapters' auth settings.

export const agentAuthEnv: Readonly<
  Record<AeoAgentSurface, { anyOf: readonly string[]; purpose: string }>
> = {
  claude_code: {
    anyOf: authSettingNames(cliAdapterProfiles.claude_code),
    purpose:
      'Claude Code probes (subscription token from `claude setup-token`, or an API key)',
  },
  codex: {
    anyOf: authSettingNames(cliAdapterProfiles.codex),
    purpose:
      'Codex probes (an API key, or a CODEX_HOME provisioned with `codex login --with-api-key`)',
  },
  cursor: {
    anyOf: authSettingNames(cliAdapterProfiles.cursor),
    purpose: 'Cursor probes',
  },
};

export const assertAgentAuth = (
  surfaces: readonly AeoAgentSurface[],
  { env, transport }: AgentRuntime,
): void => {
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

const workerVersionSchema = z.string().nullish();

const getVersionSurface = (command: string): AeoAgentSurface => {
  if (command === 'claude') {
    return 'claude_code';
  }

  if (command === 'codex') {
    return 'codex';
  }

  return 'cursor';
};

const cliVersion = async (
  command: string,
  args: string[],
  { env, transport }: AgentRuntime,
): Promise<string | null> => {
  try {
    if (transport) {
      const version = await transport.invoke(getVersionSurface(command), {
        task: 'version',
      });

      return workerVersionSchema.parse(version) ?? null;
    }

    const local = localCommand(command, args, env);
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
  const adapter = createCliAdapter(surface, {
    runtime: {
      ...runtime,
      timeoutMs: Math.min(runtime.timeoutMs ?? 120_000, 120_000),
    },
  });

  // A canary is a preflight operation (spec §4.2): recorded like a probe,
  // before the CLI starts, since it may cost something.
  const attempted = await runProbeAttempts(
    adapter,
    { promptId: 'canary', promptText: canaryPrompt, runIndex: 0 },
    {
      rules: attemptRules.canary,
      trace,
      signal,
      log,
      logContext: { surface },
    },
  );

  if (attempted.status === 'answered') {
    const { answer } = attempted;

    log.info('Canary probe passed', {
      surface,
      durationMs: Date.now() - startedAt,
      chars: answer.answerText.length,
    });

    const reportedModel = reportedModelOf(adapter, answer);
    const unrecorded = await endAttempt(attempted.handle, {
      outcome: 'succeeded',
      text: answer.answerText,
      retrieval: answer.retrieval,
      requestedModel: requestedModelOf(adapter, answer.requestedModel),
      ...(reportedModel ? { reportedModel } : {}),
    });

    return unrecorded === null
      ? null
      : { kind: 'persistence', message: unrecorded, surface };
  }

  // A canary whose operation cannot be opened, or whose run was stopped,
  // stops the preflight itself.
  if (attempted.cause instanceof ProbeTraceError) {
    throw attempted.cause;
  }

  signal?.throwIfAborted();

  if (attempted.cause !== undefined) {
    log.error('Canary probe failed', attempted.cause, {
      surface,
      kind: attempted.kind,
      detail: attempted.lastError,
    });
  }

  return { kind: attempted.kind, message: attempted.lastError, surface };
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
  // Runs per prompt per surface: the config's agentProbes depth (spec §5,
  // revised 2026-08-21). Omitted = the canonical surfaceRunCounts value.
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
  const adapter = createCliAdapter(spec.surface, { runtime: ctx.runtime });

  return runProbeUnit(
    adapter,
    {
      promptId: spec.prompt.id,
      promptText: spec.prompt.promptText,
      runIndex: spec.runIndex,
    },
    {
      rules: attemptRules.agent,
      trace: ctx.trace,
      limiter: ctx.limiter,
      signal: ctx.signal,
      log,
      logContext: {
        ...ctx.logContext,
        surface: spec.surface,
        promptId: spec.prompt.id,
        run: spec.runIndex,
      },
      toResult: (answer): AgentProbeResult => ({
        promptId: spec.prompt.id,
        promptText: spec.prompt.promptText,
        promptCategory: spec.prompt.category,
        modelName: spec.surface,
        runIndex: spec.runIndex,
        text: answer.text,
        usedWebSearch: answer.usedWebSearch ?? null,
        agentCliVersion: ctx.version,
        ...(answer.retrieval ? { retrieval: answer.retrieval } : {}),
        requestedModel: answer.requestedModel,
        ...(answer.reportedModel
          ? { reportedModel: answer.reportedModel }
          : {}),
      }),
      ...(ctx.onResult && { bank: ctx.onResult }),
    },
  );
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
  // The isolated adapter container's own policy, set by its bootstrap: it
  // launches no CLI itself, whatever a caller passes.
  if (readEnv('AEO_ISOLATED_ADAPTER') === '1') {
    throw new Error('Direct CLI launch prohibited in adapter.');
  }

  // Direct means on this machine: a transport the caller passed is not used.
  return probeForSurface(surface)(
    prompt,
    { ...runtime, transport: undefined },
    signal,
  );
};
