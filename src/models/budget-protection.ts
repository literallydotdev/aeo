import type { ModelCallAccounting } from './accounting';
import type { InternalModelProfile, InternalModelRoleConfig } from './profiles';

const getMaximumCall = (role: InternalModelRoleConfig) => {
  const maximum = {
    usd:
      (role.maxInputTokens * role.pricingUsdPerMillion.input * 1.25 +
        role.maxOutputTokens * role.pricingUsdPerMillion.output) /
      1_000_000,
    tokens: role.maxInputTokens + role.maxOutputTokens,
  };

  return maximum;
};

/**
 * withModelBudgetProtection checks every reservation atomically against the
 * shared budget, including calls already pending in other workers. Optional
 * work cannot spend the money needed for one final copy, its verifier, and its
 * pending claim adjudication. Repairs consume the same allocation and must
 * leave the next verifier funded.
 */
export const withModelBudgetProtection = (
  accounting: ModelCallAccounting,
  profile: InternalModelProfile,
): ModelCallAccounting => {
  const copy = getMaximumCall(profile.roles.copy);
  const verifier = getMaximumCall(profile.roles.premiseVerifier);
  const adjudication = getMaximumCall(profile.roles.adjudication);

  return {
    deadlineAt: accounting.deadlineAt,
    assertOwned: () => accounting.assertOwned(),
    // Forwarded so a recording accounting still sees the request.
    observe: (callId, evidence) =>
      accounting.observe?.(callId, evidence) ?? Promise.resolve(),
    settle: (callId, usage) => accounting.settle(callId, usage),
    release: (callId) => accounting.release(callId),
    reserve: (call) => {
      let usd = copy.usd + verifier.usd;
      let tokens = copy.tokens + verifier.tokens;

      if (
        ['research', 'research_search', 'perception_claim_extraction'].includes(
          call.role,
        )
      ) {
        usd += adjudication.usd;
        tokens += adjudication.tokens;
      }

      if (call.role === 'copy') {
        usd = verifier.usd;
        tokens = verifier.tokens;
      }

      if (call.role === 'premiseVerifier') {
        usd = 0;
        tokens = 0;
      }

      return accounting.reserve({
        ...call,
        minRemainingUsd: Math.max(call.minRemainingUsd ?? 0, usd),
        minRemainingTokens: Math.max(call.minRemainingTokens ?? 0, tokens),
      });
    },
  };
};
