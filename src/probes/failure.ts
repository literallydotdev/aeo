import { APICallError } from 'ai';

// ============================================================================
// Typed probe failures (hardening spec §4.6): one vocabulary for every probe
// runner, the retry policy table, and the unit records the probe store keeps
// for units that exhausted their attempts. A failure message never carries
// the prompt text or the CLI argv — the unit is referenced by its key.
// ============================================================================

export const probeFailureKinds = [
  // Child killed on the runner's deadline, or an AbortSignal fired.
  'timeout',
  // 429/503/529, "overloaded", resource_exhausted — read from stderr or a
  // structured error, never from answer text.
  'capacity',
  // 401/403, CLI login errors, missing credentials.
  'auth',
  // Non-zero exit or an error result event with no better classification.
  'cli_error',
  // The CLI refused a web tool call: a surface-level configuration problem,
  // never retried.
  'rejected_web_tool',
  // Stream shape or consistency errors: retried once at most, surfaced as a
  // partial failure.
  'parser',
  // The surface completed its call but returned no answer text (§2.4).
  'empty_answer',
  // The store refused or failed the write; the probe is never re-executed.
  'persistence',
] as const;

export type ProbeFailureKind = (typeof probeFailureKinds)[number];

/** A probe attempt failed with a classified reason. */
export class ProbeFailure extends Error {
  readonly kind: ProbeFailureKind;

  constructor(
    kind: ProbeFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.kind = kind;
    this.name = 'ProbeFailure';
  }
}

// One retry policy for every probe runner: attempts and the pause before
// each retry, by failure kind. The analyzer, perception and domain passes
// reuse the transport kinds (capacity, timeout) for their own loops.
export type RetryPolicy = {
  maxAttempts: number;
  delaysMs: readonly number[];
};

export const probeRetryPolicy: Readonly<Record<ProbeFailureKind, RetryPolicy>> =
  {
    // The CLIs already spend minutes retrying internally before they give up;
    // a short pause only burns the second attempt (correctness spec §3.6).
    capacity: { maxAttempts: 3, delaysMs: [60_000, 180_000] },
    timeout: { maxAttempts: 2, delaysMs: [5_000] },
    cli_error: { maxAttempts: 2, delaysMs: [5_000] },
    empty_answer: { maxAttempts: 2, delaysMs: [5_000] },
    parser: { maxAttempts: 2, delaysMs: [5_000] },
    auth: { maxAttempts: 1, delaysMs: [] },
    rejected_web_tool: { maxAttempts: 1, delaysMs: [] },
    persistence: { maxAttempts: 1, delaysMs: [] },
  };

// Agent CLIs bill a subscription plan whose short-window limit clears in
// minutes (Codex on Pro Lite, 2026-10-21: the first answers pass, then 429
// until the window resets). Their capacity failures back off exponentially
// for about half an hour; every other kind follows the table above.
export const agentProbeRetryPolicy: Readonly<
  Record<ProbeFailureKind, RetryPolicy>
> = {
  ...probeRetryPolicy,
  capacity: {
    maxAttempts: 6,
    delaysMs: [60_000, 120_000, 240_000, 480_000, 960_000],
  },
};

/** Milliseconds before the next attempt, or null when the policy is spent. */
export const retryDelayMs = (
  kind: ProbeFailureKind,
  attempt: number,
  policy: Readonly<Record<ProbeFailureKind, RetryPolicy>> = probeRetryPolicy,
): number | null => {
  const rule = policy[kind];

  if (attempt >= rule.maxAttempts) {
    return null;
  }

  return rule.delaysMs[attempt - 1] ?? rule.delaysMs.at(-1) ?? null;
};

const capacityErrorPattern =
  /overloaded|resource[_ ]exhausted|rate[ -]?limit|too many requests|\b(?:429|503|529)\b/i;

const authErrorPattern =
  /\b(?:401|403)\b|unauthori[sz]ed|forbidden|not logged in|please (?:run|log ?in)|invalid api key|authentication/i;

/** Whether a failure description looks like provider capacity rather than a bug. */
export const isCapacityError = (message: string): boolean => {
  return capacityErrorPattern.test(message);
};

export const isAuthError = (message: string): boolean => {
  return authErrorPattern.test(message);
};

/** Classifies an arbitrary thrown value; a ProbeFailure keeps its own kind. */
export const classifyProbeError = (
  error: unknown,
  fallback: ProbeFailureKind = 'cli_error',
): ProbeFailureKind => {
  if (error instanceof ProbeFailure) {
    return error.kind;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (isCapacityError(message)) {
    return 'capacity';
  }

  if (isAuthError(message)) {
    return 'auth';
  }

  return fallback;
};

export const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/**
 * Classifies an error thrown by an AI SDK call (`maxRetries: 0`, so the
 * gateway's own error reaches us unwrapped): status codes first, then the
 * abort/timeout signal, then the message.
 */
export const classifyGatewayError = (error: unknown): ProbeFailureKind => {
  if (error instanceof ProbeFailure) {
    return error.kind;
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0;

    if (status === 401 || status === 403) {
      return 'auth';
    }

    if (status === 408 || status === 504) {
      return 'timeout';
    }

    if (status === 429 || status === 503 || status === 529) {
      return 'capacity';
    }

    return 'cli_error';
  }

  if (isTimeoutLike(error)) {
    return 'timeout';
  }

  return classifyProbeError(error);
};

export const isTimeoutLike = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'TimeoutError' || error.name === 'AbortError';
};
