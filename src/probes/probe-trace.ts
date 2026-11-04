import type { RetrievalLog } from '../schema';
import type { AeoSurface } from '../surfaces';

// ============================================================================
// The probes' view of the run journal (specs/aeo-open-source-cli-spec.md
// §7.1): every probe attempt opens an operation before it dispatches and
// closes it with what came back. The port keeps probe code free of the
// bundle's recorder; src/bundle/recorder.ts supplies the implementation.
// ============================================================================

export type ProbeAttemptStart = {
  sectionKey?: string;
  surface: AeoSurface;
  promptId: string;
  promptText: string;
  runIndex: number;
  attempt: number;
  /** The attempt this one retries, so a retry points to its predecessor. */
  retryOf?: string;
  /** What the probe asks for, when it is known before dispatch. */
  requestedModel: string | null;
};

export type ProbeAttemptEnd =
  | {
      outcome: 'succeeded';
      text: string;
      retrieval: RetrievalLog | null;
      requestedModel: string | null;
      reportedModel?: string;
      noOverview?: true;
      /** What the provider reported the attempt cost, when it did. */
      costUsd?: number;
    }
  | {
      outcome: 'failed' | 'cancelled';
      kind: string;
      error: string;
    };

export type ProbeAttemptHandle = {
  id: string;
  end: (result: ProbeAttemptEnd) => Promise<void>;
};

export type ProbeTrace = {
  start: (attempt: ProbeAttemptStart) => Promise<ProbeAttemptHandle>;
};

/** withSection names the section on every attempt a trace opens. */
export const withSection = (
  trace: ProbeTrace,
  sectionKey: string,
): ProbeTrace => {
  return { start: (attempt) => trace.start({ ...attempt, sectionKey }) };
};

const describe = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/** An attempt whose operation could not be opened. Nothing was dispatched:
 * the unit fails as a persistence failure, never as a provider one, and is
 * not retried under a provider's policy. */
export class ProbeTraceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProbeTraceError';
  }
}

/** startAttempt opens an attempt's operation before its dispatch. */
export const startAttempt = async (
  trace: ProbeTrace | undefined,
  attempt: ProbeAttemptStart,
): Promise<ProbeAttemptHandle | undefined> => {
  if (!trace) {
    return undefined;
  }

  try {
    return await trace.start(attempt);
  } catch (error) {
    throw new ProbeTraceError(
      `the probe's operation could not be recorded: ${describe(error)}`,
      { cause: error },
    );
  }
};

/**
 * endAttempt closes an attempt and returns the write error, if any. A paid
 * answer whose outcome cannot be recorded is a persistence failure of the
 * unit, never a reason to probe again.
 */
export const endAttempt = async (
  handle: ProbeAttemptHandle | undefined,
  result: ProbeAttemptEnd,
): Promise<string | null> => {
  if (!handle) {
    return null;
  }

  try {
    await handle.end(result);

    return null;
  } catch (error) {
    return `the probe's outcome could not be recorded: ${describe(error)}`;
  }
};
