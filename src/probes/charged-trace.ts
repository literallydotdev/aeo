import { randomUUID } from 'node:crypto';
import {
  ModelBudgetError,
  type ModelCallAccounting,
} from '../models/accounting';
import { createLog } from '../lib/log';
import type { CatalogModel } from '../models/catalog';
import { probeEstimateUsd, profileOf, type RunBindings } from './bindings';
import type { ProbeTrace } from './probe-trace';

// ============================================================================
// Probes on the run's ledger (specs/aeo-claude-operator-spec.md §4.2): every
// probe attempt is reserved at its adapter's high estimate before it is
// dispatched and settled with the cost the gateway reported; one that
// reported none keeps charging its estimate. An attempt the cap cannot afford is never
// dispatched; the run learns of it through `exhausted` and stops resumable,
// with every answer captured so far banked.
// ============================================================================

const log = createLog('ChargedProbeTrace');

export type ChargedTrace = {
  trace: ProbeTrace;
  /** The first refusal of the cap, once an attempt was refused. */
  exhausted: () => ModelBudgetError | undefined;
};

export const chargedProbeTrace = (
  trace: ProbeTrace,
  ledger: ModelCallAccounting,
  {
    bindings,
    priced = new Map(),
  }: {
    bindings: RunBindings;
    /** The run's frozen catalog prices, for a binding the engine has no
     * flat figure for. */
    priced?: ReadonlyMap<string, CatalogModel>;
  },
): ChargedTrace => {
  let refused: ModelBudgetError | undefined;

  const charged: ProbeTrace = {
    start: async (attempt) => {
      const binding = bindings[attempt.surface];
      const profile = profileOf(binding);
      const estimateUsd = probeEstimateUsd(binding, priced).high;
      const callId = `probe:${attempt.surface}:${attempt.promptId}:${attempt.runIndex}:${attempt.attempt}:${randomUUID()}`;
      // The coding-agent surfaces run on the operator's own plan.
      const isPaid = profile.billing === 'metered';

      if (isPaid) {
        try {
          await ledger.reserve({
            callId,
            role: `probe:${attempt.surface}`,
            ...(attempt.requestedModel !== null && {
              requestedModel: attempt.requestedModel,
            }),
            reservedUsd: estimateUsd,
            inputTokens: 0,
            maxOutputTokens: 0,
          });
        } catch (error) {
          if (error instanceof ModelBudgetError) {
            refused ??= error;
          }

          throw error;
        }
      }

      let handle: Awaited<ReturnType<ProbeTrace['start']>>;

      try {
        handle = await trace.start(attempt);
      } catch (error) {
        // Not dispatched, so not charged. A release that fails leaves the
        // reservation charging its estimate: an overstatement of the spend,
        // never an understatement.
        if (isPaid) {
          await ledger.release(callId).catch((releaseError: unknown) => {
            log.warn('Probe reservation could not be released', {
              callId,
              error:
                releaseError instanceof Error
                  ? releaseError.message
                  : String(releaseError),
            });
          });
        }

        throw error;
      }

      return {
        id: handle.id,
        end: async (result) => {
          await handle.end(result);

          if (!isPaid) {
            return;
          }

          const reportedUsd =
            result.outcome === 'succeeded' ? result.costUsd : undefined;

          // Without a reported cost the call keeps charging its estimate,
          // and the ledger records no cost the provider did not report.
          // The outcome is recorded by now, so a settlement that fails (the
          // operator stopped the run, the ledger could not be written) must
          // not fail the unit: its paid answer would go unbanked and be
          // bought again on resume. The call keeps charging its estimate,
          // an overstatement of the spend, never an understatement.
          await ledger
            .settle(callId, {
              ...(attempt.requestedModel !== null && {
                requestedModel: attempt.requestedModel,
              }),
              ...(reportedUsd !== undefined && { costUsd: reportedUsd }),
              ...(result.outcome !== 'succeeded' && { valid: false }),
            })
            .catch((settleError: unknown) => {
              log.warn('Probe cost could not be settled', {
                callId,
                error:
                  settleError instanceof Error
                    ? settleError.message
                    : String(settleError),
              });
            });
        },
      };
    },
  };

  return { trace: charged, exhausted: () => refused };
};
