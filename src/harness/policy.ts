import { z } from 'zod';
import { contentHash } from '../stores/content-hash';

// ============================================================================
// Pinned execution policy: the lease terms an execution is claimed under.
// Stored with the execution at admission and digested into the admission
// manifest, so a resumed execution runs under the terms it was admitted
// with. Executions pinned before the Codex workflow carried the old harness
// loop's allowances as well; unknown keys are dropped on read.
// ============================================================================

export const harnessPolicySchema = z.object({
  version: z.literal(1),
  /** How long a claim holds the execution without a heartbeat. */
  leaseMs: z.number().int().positive(),
  /** How often the owning job renews its lease. */
  heartbeatMs: z.number().int().positive(),
});

export type HarnessPolicy = z.infer<typeof harnessPolicySchema>;

export const defaultHarnessPolicy = (): HarnessPolicy => {
  return { version: 1, leaseMs: 90_000, heartbeatMs: 30_000 };
};

export const harnessPolicyDigest = (policy: HarnessPolicy): string => {
  return contentHash(harnessPolicySchema.parse(policy));
};
