import {
  chargedTotal,
  type LedgerCall,
  type ModelCallAccounting,
} from '../models/accounting';
import type { ResearchUsage } from './session';

type TrackResearchUsageOptions = {
  accounting: ModelCallAccounting;
  onUsage?: (usage: ResearchUsage) => void;
};

/**
 * trackResearchUsage settles one research decision or adjudication, which can
 * contain multiple provider calls, from the same receipts as the shared model
 * ledger. Indeterminate usage retains the corresponding reservation.
 */
export const trackResearchUsage = async <T>(
  run: (accounting: ModelCallAccounting) => Promise<T>,
  { accounting, onUsage }: TrackResearchUsageOptions,
): Promise<T> => {
  const calls = new Map<string, LedgerCall>();

  try {
    return await run({
      deadlineAt: accounting.deadlineAt,
      assertOwned: () => accounting.assertOwned(),
      // Forwarded so a recording accounting still sees the request.
      observe: (callId, evidence) =>
        accounting.observe?.(callId, evidence) ?? Promise.resolve(),
      reserve: async (call) => {
        await accounting.reserve(call);
        calls.set(call.callId, { ...call });
      },
      settle: async (id, usage) => {
        await accounting.settle(id, usage);

        const call = calls.get(id);

        if (call) {
          call.usage = usage;
        }
      },
      release: async (id) => {
        await accounting.release(id);
        calls.delete(id);
      },
    });
  } finally {
    onUsage?.(chargedTotal(calls.values()));
  }
};
