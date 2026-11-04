import { createMemoryModelAccounting } from '../models/accounting';
import type { InternalModelContext } from '../models/context';
import {
  codexRunnerProfile,
  configuredModelProfileId,
  resolveInternalModelProfile,
  type InternalModelProfileId,
} from '../models/profiles';

// ============================================================================
// The host's own model calls in the Codex workflow (perception, source
// labels, the copy premise verifier) run under a small memory budget per
// step; there is no run ledger here. The premise verifier follows the role
// the run pinned at admission, because the publication gate re-checks the
// copy receipt against that role; a local run has no pin and falls back to
// the DeepSeek-only profile's verifier. Every admission pins
// `deepseek-harness-v1` (policy.ts) so no judgment role resolves to a
// premium model (Andrei, 2026-09-13).
// ============================================================================

export const hostStepMaxUsd = 5;
export const copyVerifierProfile: InternalModelProfileId = codexRunnerProfile;

export const hostModels = (
  profileId: InternalModelProfileId = configuredModelProfileId(),
): InternalModelContext => {
  return {
    profile: resolveInternalModelProfile(profileId),
    accounting: createMemoryModelAccounting({
      maxUsd: hostStepMaxUsd,
      maxTokens: 5_000_000,
      deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  };
};
