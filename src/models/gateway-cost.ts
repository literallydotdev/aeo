import { isObject } from '../lib/type-guards';

// ============================================================================
// The cost the Vercel AI Gateway reports for a call, read one way for every
// caller: host model calls (structured.ts) and chat probes alike. A value the
// gateway did not report, or reported in a shape that is not a cost, is
// unknown (undefined), never zero.
// ============================================================================

/** reportedNumber reads a non-negative number given as a number or a
 * numeric string. */
const reportedNumber = (value: unknown): number | undefined => {
  const number =
    typeof value === 'string' && value.trim() ? Number(value) : value;

  return typeof number === 'number' && Number.isFinite(number) && number >= 0
    ? number
    : undefined;
};

/** gatewayCostUsd is the cost in a response's provider metadata, when the
 * gateway reported one. */
export const gatewayCostUsd = (
  providerMetadata: unknown,
): number | undefined => {
  const cost =
    isObject(providerMetadata) && isObject(providerMetadata.gateway)
      ? providerMetadata.gateway.cost
      : undefined;

  return reportedNumber(cost);
};
