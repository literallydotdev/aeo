type ModelCallAbortReason = 'deadline' | 'cancelled';

/**
 * ModelCallAbortError keeps the host's abort decision separate from provider
 * failures. A provider may wrap a host abort as HTTP 500, and callers must not
 * mistake it for a transient provider failure.
 */
export class ModelCallAbortError extends Error {
  readonly reason: ModelCallAbortReason;

  constructor(reason: ModelCallAbortReason, cause: unknown) {
    super(
      reason === 'deadline'
        ? 'Model call exceeded its host deadline'
        : 'Model call was cancelled by the host',
      { cause },
    );

    this.reason = reason;
    this.name = 'ModelCallAbortError';
  }
}

const getAbortReason = (signal: AbortSignal): ModelCallAbortReason => {
  const isTimeout =
    signal.reason instanceof DOMException &&
    signal.reason.name === 'TimeoutError';

  return isTimeout ? 'deadline' : 'cancelled';
};

export const assertModelCallActive = (
  signal: AbortSignal,
  cause: unknown = signal.reason,
): void => {
  if (signal.aborted) {
    throw new ModelCallAbortError(getAbortReason(signal), cause);
  }
};
