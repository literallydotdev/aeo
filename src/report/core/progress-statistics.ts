// ============================================================================
// Change or noise (method release spec §7.2): the stratified exact test.
//
// Each matched (section, question, surface) is a stratum with the same runs
// in both audits. If the product's answers to it did not change, its
// positive outcomes are as likely to fall in either audit, so its current
// count is hypergeometric. The total current count's null distribution is the
// convolution of the strata's, computed exactly on integers: no random
// numbers, no seed, and no floating point before the p-value is rounded.
//
// Free of zod and of the schema: the website's client island imports it.
// ============================================================================

/** Statistics version 1: this test, two-sided, at α = 0.05 (spec §12,
 * decision 6). Changing any of the three is a new version. */
export const progressStatisticsVersion = 1;

export type ProgressStratum = {
  /** Runs in each audit: the stratum's matched slots per side. */
  runs: number;
  /** Positive outcomes among the baseline runs. */
  baseline: number;
  /** Positive outcomes among the current runs. */
  current: number;
};

/** Why a group carries no statistic. `comparison_partial`: the comparison
 * of that group is partial, on the reasons the group itself carries. */
export type ProgressStatisticSkip =
  'comparison_partial' | 'section_or_surface_selected' | 'too_large_to_compute';

export type ProgressStatistic =
  | {
      version: typeof progressStatisticsVersion;
      computed: true;
      method: 'stratified_exact';
      /** Rounded up to 6 decimals: never smaller than the exact value. */
      pValue: number;
      largerThanVariation: boolean;
    }
  | {
      version: typeof progressStatisticsVersion;
      computed: false;
      reason: ProgressStatisticSkip;
    };

const significanceLevel = 0.05;

// The longest null distribution computed. Its integers grow with its length,
// so the cost grows with the cube: a span of 2000 takes about a quarter of a
// second, 4000 about two (measured 2026-11-10). The website computes this on
// a click; the largest real audits stay well under the cap, and a group over
// it says so rather than freezing the page.
const maxSpan = 2000;

const assertStratum = ({ runs, baseline, current }: ProgressStratum) => {
  const isCountWithin = (count: number) => {
    return Number.isSafeInteger(count) && count >= 0 && count <= runs;
  };

  if (
    !Number.isSafeInteger(runs) ||
    runs < 1 ||
    !isCountWithin(baseline) ||
    !isCountWithin(current)
  ) {
    throw new Error(
      `A progress stratum needs whole counts within its runs; got ${JSON.stringify({ runs, baseline, current })}.`,
    );
  }
};

/** Row n of Pascal's triangle: C(n, 0) … C(n, n). */
const binomialRow = (n: number): bigint[] => {
  let row: bigint[] = [1n];

  for (let size = 1; size <= n; size += 1) {
    row = [...row, 0n].map((value, index) => value + (row[index - 1] ?? 0n));
  }

  return row;
};

const convolve = (left: bigint[], right: bigint[]): bigint[] => {
  const sum: bigint[] = Array.from(
    { length: left.length + right.length - 1 },
    () => 0n,
  );

  for (const [i, a] of left.entries()) {
    for (const [j, b] of right.entries()) {
      sum[i + j] = (sum[i + j] ?? 0n) + a * b;
    }
  }

  return sum;
};

/** The current counts a stratum's positives allow: [low, high]. */
const supportOf = ({ runs, baseline, current }: ProgressStratum) => {
  const positives = baseline + current;

  return {
    positives,
    low: Math.max(0, positives - runs),
    high: Math.min(positives, runs),
  };
};

/** The two-sided p-value: P(|T − E[T]| ≥ |t − E[T]|) under the null. */
const stratifiedExactPValue = (strata: readonly ProgressStratum[]): number => {
  const rows = new Map<number, bigint[]>();
  const choose = (n: number, k: number): bigint => {
    const row = rows.get(n) ?? binomialRow(n);

    rows.set(n, row);

    return row[k] ?? 0n;
  };
  // Weights of the total, each stratum's count shifted to start at zero.
  let distribution: bigint[] = [1n];
  let observed = 0;
  // Twice the expected shifted total, so every comparison stays on integers.
  let twiceExpected = 0;

  for (const stratum of strata) {
    const { runs, current } = stratum;
    const { positives, low, high } = supportOf(stratum);

    // Every split is the same split: the stratum carries no information.
    if (low === high) {
      continue;
    }

    const weights: bigint[] = [];

    for (let count = low; count <= high; count += 1) {
      weights.push(
        choose(positives, count) * choose(2 * runs - positives, runs - count),
      );
    }
    distribution = convolve(distribution, weights);
    observed += current - low;
    // E[count] = positives / 2: half the stratum's slots are current ones.
    twiceExpected += positives - 2 * low;
  }

  const observedDistance = Math.abs(2 * observed - twiceExpected);
  let total = 0n;
  let extreme = 0n;

  for (const [value, weight] of distribution.entries()) {
    total += weight;
    if (Math.abs(2 * value - twiceExpected) >= observedDistance) {
      extreme += weight;
    }
  }

  const micro = (extreme * 1_000_000n + total - 1n) / total;

  return Number(micro) / 1_000_000;
};

/** The change-or-noise statistic of one metric over a group's strata. */
export const progressStatistic = (
  strata: readonly ProgressStratum[],
): ProgressStatistic => {
  strata.forEach(assertStratum);
  const span = strata.reduce((sum, stratum) => {
    const { low, high } = supportOf(stratum);

    return sum + high - low;
  }, 0);

  if (span > maxSpan) {
    return {
      version: progressStatisticsVersion,
      computed: false,
      reason: 'too_large_to_compute',
    };
  }

  const pValue = stratifiedExactPValue(strata);

  return {
    version: progressStatisticsVersion,
    computed: true,
    method: 'stratified_exact',
    pValue,
    // From the rounded-up p-value, so the flag and the number never disagree
    // and a borderline result is never called a change.
    largerThanVariation: pValue < significanceLevel,
  };
};
