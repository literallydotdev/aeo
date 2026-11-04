import {
  createMemoryModelAccounting,
  type ModelCallAccounting,
} from '../models/accounting';
import type { InternalModelContext } from '../models/context';
import type { InternalModelProfile } from '../models/profiles';

// ============================================================================
// The host's own model calls in the Codex workflow (perception, source
// labels, the copy premise verifier) when the caller supplies no ledger: a
// small memory budget per step, on the profile the run pinned. A local run
// always supplies its ledger; this is the fallback for a host that does
// not.
// ============================================================================

export const hostStepMaxUsd = 5;

/** A fresh memory budget for one host step. */
export const hostStepAccounting = (): ModelCallAccounting => {
  return createMemoryModelAccounting({
    maxUsd: hostStepMaxUsd,
    maxTokens: 5_000_000,
    deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
};

export const hostModels = (
  profile: InternalModelProfile,
): InternalModelContext => {
  return { profile, accounting: hostStepAccounting() };
};

/** The profile a run pinned; a run without one cannot call a model. */
export const pinnedProfileOf = (
  profile: InternalModelProfile | undefined,
): InternalModelProfile => {
  if (!profile) {
    throw new Error(
      'The run request pins no model profile; the host model steps need one.',
    );
  }

  return profile;
};
