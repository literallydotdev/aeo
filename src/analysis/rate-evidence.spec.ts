import { describe, expect, it } from 'vitest';
import { rateEvidence } from './rate-evidence';

// ============================================================================
// Rate evidence (method release spec §6.2). The expected bounds are the
// Wilson score interval worked by hand at z = 1.959964 and rounded to six
// decimals.
// ============================================================================

describe('rate-evidence - rateEvidence()', () => {
  it('should give the Wilson interval of a fully captured rate', () => {
    // 10 of 20: symmetric around 0.5, half-width 0.200702.
    expect(rateEvidence(10, 20, 20)).toEqual({
      count: 10,
      captured: 20,
      planned: 20,
      low: 0.299298,
      high: 0.700702,
    });
  });

  it('should keep a zero rate off zero at its upper bound', () => {
    // 0 of 10: the upper bound is (z²/n) / (1 + z²/n).
    expect(rateEvidence(0, 10, 10)).toMatchObject({ low: 0, high: 0.277533 });
  });

  it('should cover every outcome a missing answer could have had', () => {
    const full = rateEvidence(4, 20, 20);
    const missing = rateEvidence(4, 16, 20);

    // The low bound is the same; the high bound counts the 4 missing
    // answers as mentioned: the Wilson high of 8 of 20.
    expect(missing?.low).toBe(full?.low);
    expect(missing?.high).toBe(rateEvidence(8, 20, 20)?.high);
  });

  it('should give a surface whose every probe failed the honest [0, 1]', () => {
    expect(rateEvidence(0, 0, 12)).toMatchObject({ low: 0, high: 1 });
  });

  it('should have no evidence for a rate with nothing planned', () => {
    expect(rateEvidence(0, 0, 0)).toBeNull();
  });

  it('should round to six decimals and stay within [0, 1]', () => {
    for (let count = 0; count <= 7; count++) {
      const evidence = rateEvidence(count, 7, 7);

      expect(evidence?.low).toBeGreaterThanOrEqual(0);
      expect(evidence?.high).toBeLessThanOrEqual(1);
      expect(Math.round((evidence?.low ?? 0) * 1e6) / 1e6).toBe(evidence?.low);
    }
  });
});
