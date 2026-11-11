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
    'should fail doctor for a model that could not be priced, with the reason, and name %s',
    (modelId) => {
      const check = modelCheck({
        outcome: 'refused',
        reason: "acme/unlisted is not on the gateway's model list.",
      });

      expect(check.ok).toBe(false);
      expect(check.detail).toContain('acme/unlisted is not on the gateway');
      expect(check.detail).toContain(modelId);
    },
  );

  it('should pass doctor for the recommended model, and say it was chosen for the user', () => {
    const check = modelCheck(undefined);

    expect(check.ok).toBe(true);
    expect(check.detail).toContain('recommended');
  });

  it('should pass doctor for any priced gateway model, and say where its price came from and that it is unverified', () => {
    const check = modelCheck({
      outcome: 'resolved',
      named: true,
      model: {
        ...resolveSupportedModel(),
        id: 'acme/model',
        pricingUsdPerMillion: { input: 1.1, output: 2.2, cachedInput: 0.11 },
        pricingCheckedAt: '2026-11-10',
        stageRuntimeVerifiedAt: null,
      },
    });

    expect(check).toEqual({
      name: 'model',
      ok: true,
      detail:
        "acme/model; asked at effort high; priced from the gateway's model list on 2026-11-10, at up to 1.1 in / 2.2 out USD per million tokens; not yet verified on the Codex stage runtime through the gateway",
    });
  });

  it('should name the model an audit has write the narrative, with where its price came from', () => {
    const model = resolveSupportedModel();

    const check = modelCheck({
      outcome: 'resolved',
      named: false,
      model,
      writer: {
        ...model,
        id: 'acme/writer',
        pricingUsdPerMillion: { input: 1.75, output: 14, cachedInput: 0.17 },
        pricingCheckedAt: '2026-11-10',
        stageRuntimeVerifiedAt: null,
      },
    });

    expect(check.ok).toBe(true);
    // The writer runs no Codex stage: only the report model's verification
    // on that runtime is reported.
    expect(check.detail).toBe(
      `${model.id} (recommended; audit.json names none); asked at effort ${model.stageReasoningEffort}; verified on the Codex stage runtime ${model.stageRuntimeVerifiedAt}; the narrative is written by acme/writer, priced from the gateway's model list on 2026-11-10, at up to 1.75 in / 14 out USD per million tokens`,
    );
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

  it('should run the copy role alone on the writer an audit names, as a profile of its own', () => {
    const model = resolveSupportedModel();
    const writer = resolveSupportedModel('anthropic/claude-sonnet-5.5');
    const plain = localModelProfile(model, { searchProvider: 'disabled' });

    const profile = localModelProfile(model, {
      searchProvider: 'disabled',
      writer,
    });

    expect(profile.roles.copy).toMatchObject({
      model: writer.id,
      pricingUsdPerMillion: writer.pricingUsdPerMillion,
    });
    // Every other role, the premise verifier included, and the stages stay
    // on the report model.
    expect({ ...profile.roles, copy: plain.roles.copy }).toEqual(plain.roles);
    expect(profile.stages).toEqual(plain.stages);
    expect(profile.id).toBe(`local:${model.id}+write:${writer.id}`);
    expect(internalModelProfileDigest(profile)).not.toBe(
      internalModelProfileDigest(plain),
    );
  });

  it('should give each model its own method digest', () => {
    const digests = supportedModels.map((model) =>
      internalModelProfileDigest(
        localModelProfile(model, { searchProvider: 'disabled' }),
      ),
    );

    expect(new Set(digests).size).toBe(supportedModels.length);
  });
});
