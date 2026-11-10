// ============================================================================
// How an interval is shown (method release spec §6.5): outward, in whole
// percents, so the range a reader sees always contains the computed one.
// Zod-free: the report page's client island imports it, and the fact
// sentences use it, so every place that states an interval rounds it the
// same way. The local viewer's page is a self-contained script and carries
// its own copy of this rule (viewer/page.ts, `intervalText`).
// ============================================================================

/** The whole-percent range that contains [low, high], two shares in 0..1.
 * The bounds are stored to 6 decimals; scaling them to an integer first
 * keeps 0.07 (7.000000000000001 once multiplied by 100) at 7%. */
export const intervalPercents = ({
  low,
  high,
}: {
  low: number;
  high: number;
}): { low: number; high: number } => {
  return {
    low: Math.floor(Math.round(low * 1e6) / 1e4),
    high: Math.ceil(Math.round(high * 1e6) / 1e4),
  };
};
