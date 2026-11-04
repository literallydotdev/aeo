import { describe, expect, it } from 'vitest';
import { modelCheck } from '../engine/preflight';
import { localModelProfile } from './local-profile';
import { internalModelProfileDigest } from './profiles';
import {
  recommendedModelId,
  resolveSupportedModel,
  supportedModels,
  supportedModelSchema,
  UnsupportedModelError,
} from './supported-models';

const modelIds = supportedModels.map((model) => [model.id] as const);

describe('supported-models - supportedModels', () => {
  it('should hold only well-formed entries, the recommended model among them', () => {
    const invalid = supportedModels.filter(
      (model) => !supportedModelSchema.safeParse(model).success,
    );

    expect(invalid).toEqual([]);
    expect(supportedModels.map((model) => model.id)).toContain(
      recommendedModelId,
    );
  });
});

describe('supported-models - resolveSupportedModel()', () => {
  it('should resolve the recommended model when none is named', () => {
    expect(resolveSupportedModel().id).toBe(recommendedModelId);
  });

  it('should refuse a model not on the list and print the list', () => {
    const resolve = () => resolveSupportedModel('provider/unknown-model');

    expect(resolve).toThrow(UnsupportedModelError);
    expect(resolve).toThrow(recommendedModelId);
  });
});

describe('preflight - modelCheck()', () => {
  it.each(modelIds)(
    'should fail doctor for a model not on the list, naming %s',
    (modelId) => {
      const check = modelCheck('provider/unknown-model');

      expect(check.ok).toBe(false);
      expect(check.detail).toContain(modelId);
    },
  );

  it('should pass doctor for the recommended model, and say it was chosen for the user', () => {
    const check = modelCheck(undefined);

    expect(check.ok).toBe(true);
    expect(check.detail).toContain('recommended');
  });
});

describe('local-profile - localModelProfile()', () => {
  it.each(modelIds)(
    'should run every text role and the Codex stages on %s alone',
    (modelId) => {
      const model = resolveSupportedModel(modelId);

      const profile = localModelProfile(model, { searchProvider: 'disabled' });
      const roles = Object.values(profile.roles);

      expect(new Set(roles.map((role) => role.model))).toEqual(
        new Set([model.id]),
      );
      expect(
        roles.filter((role) => role.maxOutputTokens > model.maxOutputTokens),
      ).toEqual([]);
      expect(profile.stages).toEqual({
        model: model.id,
        reasoningEffort: model.stageReasoningEffort,
        contextWindow: model.contextWindow,
        pricingUsdPerMillion: model.pricingUsdPerMillion,
      });
    },
  );

  it('should give each model its own method digest', () => {
    const digests = supportedModels.map((model) =>
      internalModelProfileDigest(
        localModelProfile(model, { searchProvider: 'disabled' }),
      ),
    );

    expect(new Set(digests).size).toBe(supportedModels.length);
  });
});
