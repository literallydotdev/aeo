import { localModelProfile, localStageModel } from './local-profile';
import type { CodexStageModel, InternalModelProfile } from './profiles';
import { resolveSupportedModel } from './supported-models';

// ============================================================================
// The model profile tests run under: the local profile of the recommended
// model, with search off unless a test turns it on. Tests that care which
// model a role names read it from here, never from a literal.
// ============================================================================

export const testModelProfileFixture = (
  searchProvider: InternalModelProfile['searchProvider'] = 'disabled',
): InternalModelProfile => {
  return localModelProfile(resolveSupportedModel(), { searchProvider });
};

export const testStageModelFixture: CodexStageModel = localStageModel(
  resolveSupportedModel(),
);
