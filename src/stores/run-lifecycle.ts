import type { RunClaim, RunClaimResult, RunRecord } from './ports';

export const terminalRunStatuses = [
  'completed',
  'blocked',
  'failed',
  'cancelled',
] as const;

export const isTerminalRun = (record: RunRecord): boolean => {
  return terminalRunStatuses.some((status) => status === record.status);
};

export const evaluateRunClaim = (
  record: RunRecord | null,
  claim: RunClaim,
): RunClaimResult => {
  if (!record) {
    return { status: 'missing' };
  }

  if (isTerminalRun(record)) {
    return { status: 'terminal', record };
  }

  if (
    record.status === 'running' &&
    record.batchJobId &&
    record.batchJobId !== claim.batchJobId
  ) {
    return { status: 'duplicate', record };
  }

  if (record.batchAttempt && record.batchAttempt > claim.attempt) {
    return { status: 'duplicate', record };
  }

  const claimed: RunClaimResult = {
    status: 'claimed',
    record: {
      ...record,
      status: 'running',
      batchJobId: claim.batchJobId,
      batchAttempt: claim.attempt,
      dispatchedAt: new Date().toISOString(),
    },
  };

  return claimed;
};

const fileClaims = new Map<string, Promise<unknown>>();

/** serializeRunFile serializes conditional read/append changes across
 * FileRunStore instances. */
export const serializeRunFile = async <T>(
  file: string,
  action: () => Promise<T>,
): Promise<T> => {
  const previous = fileClaims.get(file) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);

  fileClaims.set(file, current);

  try {
    return await current;
  } finally {
    if (fileClaims.get(file) === current) {
      fileClaims.delete(file);
    }
  }
};
