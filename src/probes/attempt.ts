import type { Log } from '../lib/log';
import { servedModelOf } from '../models/served-model';
import type { RetrievalLog } from '../schema';
import type { ProbeAdapter, ProbeAnswer } from './adapter';
import { finalizeAnswer } from './answer-text';
import {
  agentProbeRetryPolicy,
  errorMessage,
  probeRetryPolicy,
  retryDelayMs,
  type ProbeFailureKind,
  type RetryPolicy,
} from './failure';
import { sleep, type ProbeLimiter } from './limits';
import type { ProbeOutcome, ProbeUnitRef } from './outcomes';
import {
  endAttempt,
  ProbeTraceError,
  startAttempt,
  type ProbeAttemptHandle,
  type ProbeTrace,
} from './probe-trace';

// ============================================================================
// The host's attempt loop (specs/aeo-probe-adapters-spec.md §4.3), one for
// chat surfaces, coding agents and canaries. The host owns what makes the
// evidence trustworthy: the pool, the journal (an attempt's operation opens
// before its dispatch and ends with its real outcome), retries and the
// failure taxonomy, answer finalisation and banking before anything else
// can fail. An adapter only asks and classifies.
//
// Chat units and coding agents run under the same rules (attemptRules) and
// differ only in their retry ladder: each takes its pool slot aware of the
// abort signal, jitters its retries, and on capacity pauses its own adapter
// rather than the whole pool, which serves other surfaces. A canary takes
// no pool and keeps the default ladder. These are run policy, not method.
// ============================================================================

type AttemptRules = {
  /** The family's name in log lines. */
  label: string;
  policy: Readonly<Record<ProbeFailureKind, RetryPolicy>>;
  /** ±20% on every retry delay, so units that failed together do not all
   * retry in the same second. */
  jitter: boolean;
  /** Whether the attempt takes a slot on its adapter's pool. */
  pooled: boolean;
  completedLevel: 'debug' | 'info';
};

export const attemptRules = {
  chat: {
    label: 'Probe',
    policy: probeRetryPolicy,
    jitter: true,
    pooled: true,
    completedLevel: 'debug',
  },
  agent: {
    label: 'Agent probe',
    policy: agentProbeRetryPolicy,
    jitter: true,
    pooled: true,
    completedLevel: 'info',
  },
  canary: {
    label: 'Canary probe',
    policy: probeRetryPolicy,
    jitter: false,
    pooled: false,
    completedLevel: 'info',
  },
} as const satisfies Record<string, AttemptRules>;

const retryJitterRatio = 0.2;

const addJitter = (delayMs: number): number => {
  const factor = 1 - retryJitterRatio + Math.random() * 2 * retryJitterRatio;

  return Math.round(delayMs * factor);
};

/** What the journal names an attempt by. */
export type AttemptUnit = {
  promptId: string;
  promptText: string;
  runIndex: number;
};

export type AttemptHost = {
  rules: AttemptRules;
  trace?: ProbeTrace;
  /** Required unless the rules take no pool. */
  limiter?: ProbeLimiter;
  signal?: AbortSignal;
  log: Log;
  logContext: Record<string, unknown>;
};

export type AttemptResult =
  | {
      status: 'answered';
      answer: ProbeAnswer;
      attempts: number;
      durationMs: number;
      /** The answered attempt's open operation; the caller ends it. */
      handle: ProbeAttemptHandle | undefined;
    }
  | {
      status: 'failed';
      kind: ProbeFailureKind;
      lastError: string;
      attempts: number;
      /** The last error thrown, when one was: a provider error, or the
       * ProbeTraceError of an operation that could not be opened. */
      cause?: unknown;
    };

/**
 * requestedModelOf is the model a probe asked for: the model its binding
 * pins for a model API; otherwise the one the answer names (Codex learns
 * it only when it answers); otherwise none.
 */
export const requestedModelOf = (
  bound: { model?: string },
  answeredModel?: string | null,
): string | null => {
  return bound.model ?? answeredModel ?? null;
};

/** The key one adapter's capacity pause is held under: the adapter serving
 * this surface, never the pool it shares with others. */
const pauseKeyOf = (adapter: ProbeAdapter): string => {
  return `${adapter.id}|${adapter.surface}`;
};

/** A unit whose run was aborted while it waited for its pool slot: it is
 * not dispatched once the slot frees. */
class AbortedBeforeDispatchError extends Error {
  constructor() {
    super('run aborted before the unit executed');
    this.name = 'AbortedBeforeDispatchError';
  }
}

const inPool = async <T>(
  adapter: ProbeAdapter,
  { rules, limiter, signal }: AttemptHost,
  work: () => Promise<T>,
): Promise<T> => {
  if (!rules.pooled || !limiter) {
    return work();
  }

  return limiter.run(
    adapter.pool,
    async () => {
      if (signal?.aborted) {
        throw new AbortedBeforeDispatchError();
      }

      return work();
    },
    { signal, pauseKey: pauseKeyOf(adapter) },
  );
};

/**
 * runProbeAttempts asks `adapter` until it answers or its retry policy is
 * spent. Each attempt opens its operation inside the pool slot, so the
 * operation starts when the request does, and before it: no dispatch goes
 * unrecorded. An answered attempt's operation is left open for the caller,
 * who finalises the answer before ending it.
 */
export const runProbeAttempts = async (
  adapter: ProbeAdapter,
  unit: AttemptUnit,
  host: AttemptHost,
): Promise<AttemptResult> => {
  const { rules, log, signal } = host;

  // A wiring mistake, refused before the first attempt: inside one it would
  // be classified and retried as a provider failure.
  if (rules.pooled && !host.limiter) {
    throw new Error(
      `Please give the ${rules.label} attempts of ${adapter.surface} a pool limiter.`,
    );
  }

  let attempt = 0;
  let handle: ProbeAttemptHandle | undefined;

  for (;;) {
    if (signal?.aborted) {
      return {
        status: 'failed',
        kind: 'timeout',
        attempts: attempt,
        lastError: 'run aborted before the unit executed',
      };
    }

    attempt += 1;
    const startedAt = Date.now();
    const retryOf = handle?.id;

    handle = undefined;

    try {
      const answer = await inPool(adapter, host, async () => {
        handle = await startAttempt(host.trace, {
          surface: adapter.surface,
          promptId: unit.promptId,
          promptText: unit.promptText,
          runIndex: unit.runIndex,
          attempt,
          ...(retryOf === undefined ? {} : { retryOf }),
          requestedModel: requestedModelOf(adapter),
          adapter: adapter.id,
          request: adapter.request(unit.promptText),
        });

        return adapter.probe(unit.promptText, { signal });
      });

      return {
        status: 'answered',
        answer,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        handle,
      };
    } catch (error) {
      // Never dispatched: the unit stays as unattempted as it was.
      if (error instanceof AbortedBeforeDispatchError) {
        return {
          status: 'failed',
          kind: 'timeout',
          attempts: attempt - 1,
          lastError: error.message,
        };
      }

      if (error instanceof ProbeTraceError) {
        return {
          status: 'failed',
          kind: 'persistence',
          attempts: attempt,
          lastError: error.message,
          cause: error,
        };
      }

      const failure = adapter.classifyError(error);
      const unrecorded = await endAttempt(handle, {
        outcome: signal?.aborted ? 'cancelled' : 'failed',
        kind: failure.kind,
        error: failure.message,
      });

      if (unrecorded !== null) {
        return {
          status: 'failed',
          kind: 'persistence',
          attempts: attempt,
          lastError: unrecorded,
        };
      }

      const ladderMs = retryDelayMs(failure.kind, attempt, rules.policy);
      const delayMs =
        ladderMs !== null && rules.jitter ? addJitter(ladderMs) : ladderMs;

      log.warn(
        delayMs === null
          ? `${rules.label} failed`
          : `${rules.label} failed; retrying`,
        {
          ...host.logContext,
          attempt,
          kind: failure.kind,
          durationMs: Date.now() - startedAt,
          ...(delayMs === null ? {} : { retryInMs: delayMs }),
          error: failure.message,
        },
      );

      if (delayMs === null) {
        return {
          status: 'failed',
          kind: failure.kind,
          attempts: attempt,
          lastError: failure.message,
          cause: error,
        };
      }

      // Every unit of this adapter waits the window out, not only this one;
      // other surfaces on the same pool keep going.
      if (failure.kind === 'capacity' && rules.pooled) {
        host.limiter?.pause(pauseKeyOf(adapter), delayMs);
      }

      await sleep(delayMs, signal);
    }
  }
};

/** reportedModelOf applies the adapter's served-model rule. */
export const reportedModelOf = (
  adapter: ProbeAdapter,
  answer: ProbeAnswer,
): string | undefined => {
  const raw = answer.servedModel === '' ? undefined : answer.servedModel;

  switch (adapter.observes.servedModel) {
    case 'compare_to_requested': {
      const requested = requestedModelOf(adapter);

      // Without a requested model there is nothing to compare against.
      return requested === null ? raw : servedModelOf(requested, raw);
    }

    case 'raw':
      return raw;

    case 'none':
      return undefined;

    default: {
      const unhandled: never = adapter.observes.servedModel;

      throw new Error(`Unhandled served-model rule: ${String(unhandled)}.`);
    }
  }
};

/** A unit's answer as it is banked and journaled. */
export type BankedAnswer = {
  text: string;
  retrieval: RetrievalLog | null;
  requestedModel: string | null;
  reportedModel?: string;
  noOverview?: true;
  usedWebSearch?: boolean | null;
};

export type UnitHost<P> = AttemptHost & {
  /** The banked result of an answer. */
  toResult: (answer: BankedAnswer) => P;
  /** Banks a captured result. A throw fails the unit as `persistence`; the
   * probe is never dispatched again (hardening spec §4.2). */
  bank?: (result: P) => Promise<void>;
};

/**
 * runProbeUnit runs one planned unit to exactly one outcome: its answer
 * finalised, its operation ended with what is banked, and the result
 * banked; or the typed failure that stopped it.
 */
export const runProbeUnit = async <P>(
  adapter: ProbeAdapter,
  unit: AttemptUnit,
  host: UnitHost<P>,
): Promise<ProbeOutcome<P>> => {
  const { log, rules } = host;
  const ref: ProbeUnitRef = {
    promptId: unit.promptId,
    surface: adapter.surface,
    runIndex: unit.runIndex,
  };

  const attempted = await runProbeAttempts(adapter, unit, host);

  if (attempted.status === 'failed') {
    return {
      status: 'failed',
      unit: ref,
      kind: attempted.kind,
      attempts: attempted.attempts,
      lastError: attempted.lastError,
    };
  }

  const { answer, attempts } = attempted;
  const final = await finalizeAnswer(answer, {
    resolvesRedirects: adapter.resolvesRedirects,
    logContext: host.logContext,
  });
  const reportedModel = reportedModelOf(adapter, answer);
  const banked: BankedAnswer = {
    text: final.text,
    retrieval: final.retrieval,
    requestedModel: requestedModelOf(adapter, answer.requestedModel),
    ...(reportedModel ? { reportedModel } : {}),
    ...(answer.noOverview ? { noOverview: true as const } : {}),
    ...(answer.usedWebSearch === undefined
      ? {}
      : { usedWebSearch: answer.usedWebSearch }),
  };

  log[rules.completedLevel](`${rules.label} completed`, {
    ...host.logContext,
    attempt: attempts,
    durationMs: attempted.durationMs,
    chars: final.text.length,
    ...(banked.usedWebSearch === undefined
      ? {}
      : {
          usedWebSearch: banked.usedWebSearch,
          retrievalCalls: final.retrieval?.calls.length ?? null,
        }),
    ...(banked.noOverview ? { noOverview: true } : {}),
  });

  const unrecorded = await endAttempt(attempted.handle, {
    outcome: 'succeeded',
    text: banked.text,
    retrieval: banked.retrieval,
    requestedModel: banked.requestedModel,
    ...(banked.reportedModel ? { reportedModel: banked.reportedModel } : {}),
    ...(banked.noOverview ? { noOverview: true as const } : {}),
    ...(answer.reportedCostUsd === undefined
      ? {}
      : { costUsd: answer.reportedCostUsd }),
    ...(final.redirects.length > 0 ? { redirects: final.redirects } : {}),
  });

  if (unrecorded !== null) {
    return {
      status: 'failed',
      unit: ref,
      kind: 'persistence',
      attempts,
      lastError: unrecorded,
    };
  }

  const result = host.toResult(banked);

  // Banking sits outside the attempt loop: a writer that throws must never
  // re-run a paid probe (§4.2).
  try {
    await host.bank?.(result);
  } catch (error) {
    log.error(
      `${rules.label} captured but could not be persisted`,
      error,
      host.logContext,
    );

    return {
      status: 'failed',
      unit: ref,
      kind: 'persistence',
      attempts,
      lastError: errorMessage(error),
    };
  }

  return { status: 'captured', unit: ref, probe: result, attempts };
};
