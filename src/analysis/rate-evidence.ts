import type { AeoRateEvidence } from '../report/core/schema';

// ============================================================================
// The counts and interval beside a published rate (specs/aeo-method-release-
// spec.md §6.2). The interval describes answer-to-answer variation for the
// audit's fixed questions, at the time of the audit (§6.1): an approximate
// 95% Wilson score interval over the planned answers. Missing answers count
// as "not mentioned" in the rate; their outcome is unknown, so the upper
// bound counts them as mentioned and the interval covers both extremes.
//
// Only + − × ÷ and Math.sqrt, which IEEE 754 rounds correctly on every
// platform, so every verifier recomputes the same bytes. No Math.pow, exp
// or log.
// ============================================================================

/** count: mentioned (or cited) captured answers; captured: captured answers
 * in the denominator's scope; planned: the denominator the rate divides
 * by. */
export type RateEvidence = AeoRateEvidence;

const z = 1.959964;
const zSquared = z * z;

const roundStored = (value: number): number => {
  return Math.round(value * 1_000_000) / 1_000_000;
};

const clampRate = (value: number): number => {
  return Math.min(1, Math.max(0, value));
};

/** wilsonBounds is the Wilson score interval of `count` over `total`. */
const wilsonBounds = (
  count: number,
  total: number,
): { low: number; high: number } => {
  const p = count / total;
  const denominator = 1 + zSquared / total;
  const centre = p + zSquared / (2 * total);
  const halfWidth =
    z * Math.sqrt((p * (1 - p)) / total + zSquared / (4 * total * total));

  return {
    low: clampRate((centre - halfWidth) / denominator),
    high: clampRate((centre + halfWidth) / denominator),
  };
};

/**
 * rateEvidence is the evidence behind `count` out of `planned` answers when
 * `captured` of them were captured; null when nothing was planned, where the
 * rate has no answers to describe.
 */
export const rateEvidence = (
  count: number,
  captured: number,
  planned: number,
): RateEvidence | null => {
  if (planned <= 0) {
    return null;
  }

  const missing = Math.max(0, planned - captured);
  const low = wilsonBounds(count, planned).low;
  const high = wilsonBounds(Math.min(planned, count + missing), planned).high;

  return {
    count,
    captured,
    planned,
    low: roundStored(low),
    high: roundStored(high),
  };
};
