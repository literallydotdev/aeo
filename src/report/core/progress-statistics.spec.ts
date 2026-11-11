import { describe, expect, it } from 'vitest';
import { progressStatistic } from './progress-statistics';

const repeated = <T>(count: number, item: T): T[] => {
  return Array.from({ length: count }, () => item);
};

describe('progress-statistics - progressStatistic()', () => {
  it('should match a convolution computed by hand', () => {
    // One run, mentioned then not: the weights over the current count are
    // C(1,c)·C(1,1−c) = [1, 1]. Three runs, three then one: positives 4 of
    // 6, the count runs 1..3 with weights C(4,c)·C(2,3−c) = [4, 12, 4]. Their
    // convolution is [4, 16, 16, 4] over 40. The expected total is 0.5 + 2
    // and the observed one 0 + 1: only the two ends are as far out, so
    // p = (4 + 4) / 40.
    expect(
      progressStatistic([
        { runs: 1, baseline: 1, current: 0 },
        { runs: 3, baseline: 3, current: 1 },
      ]),
    ).toEqual({
      version: 1,
      computed: true,
      method: 'stratified_exact',
      pValue: 0.2,
      largerThanVariation: false,
    });
  });

  it('should round the p-value up, so it is never smaller than the exact one', () => {
    // Two of two runs, then none: weights [1, 4, 1] over 6, p = 2/6.
    expect(
      progressStatistic([{ runs: 2, baseline: 2, current: 0 }]),
    ).toMatchObject({ pValue: 0.333334 });
  });

  it('should call a change within variation when the rounded p-value is not below 0.05', () => {
    // Two such strata: [1, 4, 1] convolved with itself is [1, 8, 18, 8, 1]
    // over 36, and p = 2/36.
    expect(
      progressStatistic(repeated(2, { runs: 2, baseline: 2, current: 0 })),
    ).toMatchObject({ pValue: 0.055556, largerThanVariation: false });
  });

  it('should find a total swing over 20 questions at depth 2 larger than variation', () => {
    const statistic = progressStatistic(
      repeated(20, { runs: 2, baseline: 2, current: 0 }),
    );

    // 2 · (1/6)^20, rounded up to the smallest stored value.
    expect(statistic).toMatchObject({
      pValue: 0.000001,
      largerThanVariation: true,
    });
  });

  it('should give p = 1 when every stratum has the same outcomes on both sides', () => {
    expect(
      progressStatistic([
        { runs: 2, baseline: 1, current: 1 },
        { runs: 3, baseline: 2, current: 2 },
        { runs: 1, baseline: 1, current: 1 },
        { runs: 2, baseline: 0, current: 0 },
      ]),
    ).toMatchObject({ pValue: 1, largerThanVariation: false });
  });

  it('should give the same p-value for a gain and for the same loss', () => {
    const loss = progressStatistic([
      { runs: 3, baseline: 3, current: 0 },
      { runs: 2, baseline: 1, current: 0 },
    ]);
    const gain = progressStatistic([
      { runs: 3, baseline: 0, current: 3 },
      { runs: 2, baseline: 0, current: 1 },
    ]);

    expect(gain).toEqual(loss);
  });

  it('should compute a group up to a span of 2000 counts, and decline one over it', () => {
    // Each of these strata has a span of 5: its current count can be 0 to 5.
    const stratum = { runs: 5, baseline: 5, current: 0 };

    expect(progressStatistic(repeated(400, stratum))).toMatchObject({
      computed: true,
      largerThanVariation: true,
    });
    expect(
      progressStatistic([
        ...repeated(400, stratum),
        { runs: 1, baseline: 1, current: 0 },
      ]),
    ).toEqual({ version: 1, computed: false, reason: 'too_large_to_compute' });
  });

  it('should refuse a count outside its runs', () => {
    expect(() =>
      progressStatistic([{ runs: 2, baseline: 3, current: 0 }]),
    ).toThrow(/whole counts within its runs/);
    expect(() =>
      progressStatistic([{ runs: 0, baseline: 0, current: 0 }]),
    ).toThrow(/whole counts within its runs/);
  });
});
