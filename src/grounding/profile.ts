import type { ModelBudgetLimits } from '../models/accounting';
import type {
  InternalModelProfile,
  InternalModelRoleConfig,
} from '../models/profiles';
import {
  researchProfile,
  type ResearchPhase,
  type ResearchProfile,
} from './session';

const reservation = (role: InternalModelRoleConfig) => {
  return {
    usd:
      (role.maxInputTokens * role.pricingUsdPerMillion.input * 1.25 +
        role.maxOutputTokens * role.pricingUsdPerMillion.output) /
      1_000_000,
    tokens: role.maxInputTokens + role.maxOutputTokens,
  };
};
export type ResearchProfileFromModelsOptions = {
  limits: ModelBudgetLimits;
  phase: ResearchPhase;
  searchProvider?: ResearchProfile['searchProvider'];
  purpose?: 'pipeline' | 'grounding_replay';
};

/**
 * researchProfileFromModels sizes research from the model profile. A replay
 * has no authoring or measured-analysis work to fund. Its larger research
 * allocation still shares the total cap and downstream copy reserves.
 */
export const researchProfileFromModels = (
  models: InternalModelProfile,
  {
    limits,
    phase,
    searchProvider = 'disabled',
    purpose = 'pipeline',
  }: ResearchProfileFromModelsOptions,
): ResearchProfile => {
  const decision = reservation(models.roles.research);
  const adjudication = reservation(models.roles.adjudication);
  const allocation = purpose === 'grounding_replay' ? 0.6 : 0.2;

  const profile = researchProfile(
    phase,
    {
      maxUsd: limits.maxUsd * allocation,
      maxTokens: Math.floor(limits.maxTokens * allocation),
      adjudicationReserveUsd: adjudication.usd,
      adjudicationReserveTokens: adjudication.tokens,
      decisionReserveUsd: decision.usd,
      decisionReserveTokens: decision.tokens,
      // Pinned adapter sends one 10-result live organic query. This is an explicit
      // reservation ceiling; recorded provider usage is settled against shared limits.
      searchReserveUsd: 0.02,
    },
    { searchProvider },
  );

  return profile;
};
