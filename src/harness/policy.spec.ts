import { describe, expect, it } from 'vitest';
import {
  defaultHarnessPolicy,
  harnessPolicyDigest,
  harnessPolicySchema,
} from './policy';

describe('policy - harnessPolicyDigest() and harnessPolicySchema', () => {
  const policy = defaultHarnessPolicy();

  it('should pin the lease terms and digests them deterministically', () => {
    expect(policy.leaseMs).toBe(90_000);
    expect(policy.heartbeatMs).toBe(30_000);
    expect(harnessPolicyDigest(policy)).toBe(
      harnessPolicyDigest({ ...policy }),
    );
    expect(harnessPolicyDigest(policy)).not.toBe(
      harnessPolicyDigest({ ...policy, leaseMs: 60_000 }),
    );
  });

  it('should read a policy pinned by the retired harness loop by its lease terms', () => {
    const legacy = {
      ...policy,
      repairPlansPerExecution: 12,
      finalReviewCycles: 6,
      unknownCaptureOutcome: { policy: 'operator_decision' },
    };

    const parsed = harnessPolicySchema.parse(legacy);

    expect(parsed).toEqual(policy);
    // The digest is over the terms that matter now; the dropped allowances
    // never change it.
    expect(harnessPolicyDigest(legacy)).toBe(harnessPolicyDigest(policy));
  });
});
