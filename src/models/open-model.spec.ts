import { describe, expect, it } from 'vitest';
import { ModelCatalogError, type CatalogModel } from './catalog';
import { localModelProfile } from './local-profile';
import { reportModelOf } from './open-model';

const listed = (overrides: Partial<CatalogModel> = {}): CatalogModel => {
  return {
    id: 'acme/model',
    label: 'Acme Model',
    pricingUsdPerMillion: { input: 1, output: 2, cachedInput: 0.1 },
    webSearchUsdPerRequest: null,
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    reasoning: true,
    reasoningEfforts: ['low', 'high'],
    ...overrides,
  };
};

describe('open-model - reportModelOf()', () => {
  it('should ask a model for high effort only when it offers it, and never claim it was verified', () => {
    const thinker = reportModelOf(listed(), '2026-11-10');
    const plain = reportModelOf(
      listed({ reasoning: false, reasoningEfforts: [] }),
      '2026-11-10',
    );
    const budgeted = reportModelOf(
      listed({ reasoningEfforts: ['low', 'medium'] }),
      '2026-11-10',
    );

    expect(thinker).toMatchObject({
      thinkingInOutput: true,
      providerOptions: { gateway: { reasoning: { effort: 'high' } } },
      stageReasoningEffort: 'high',
      stageRuntimeVerifiedAt: null,
      pricingCheckedAt: '2026-11-10',
    });
    expect(plain).toMatchObject({
      thinkingInOutput: false,
      providerOptions: {},
      stageReasoningEffort: 'medium',
    });
    expect(budgeted.providerOptions).toEqual({});
  });

  it('should ask a model for the effort the audit names, in its calls and in the Codex stages', () => {
    const maximal = reportModelOf(
      listed({ reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      '2026-11-10',
      'max',
    );
    const profile = localModelProfile(maximal, { searchProvider: 'disabled' });

    expect(maximal).toMatchObject({
      providerOptions: { gateway: { reasoning: { effort: 'max' } } },
      stageReasoningEffort: 'max',
      // Naming an effort verifies nothing.
      stageRuntimeVerifiedAt: null,
    });
    expect(profile.roles.analyzer.providerOptions).toEqual({
      gateway: { reasoning: { effort: 'max' } },
    });
    expect(profile.stages).toMatchObject({ reasoningEffort: 'max' });
  });

  it('should refuse an effort the catalog does not list for the model, naming the ones it does', () => {
    expect(() => reportModelOf(listed(), '2026-11-10', 'max')).toThrow(
      new ModelCatalogError(
        'acme/model is not offered at effort "max" on the gateway\'s model list: it lists low, high. Please set modelEffort to one of those, or leave it out.',
      ),
    );
    expect(() =>
      reportModelOf(
        listed({ reasoning: false, reasoningEfforts: [] }),
        '2026-11-10',
        'high',
      ),
    ).toThrow(/it lists no reasoning effort/);
  });

  it('should build a profile the engine accepts, a free model included', () => {
    const free = reportModelOf(
      listed({ pricingUsdPerMillion: { input: 0, output: 0, cachedInput: 0 } }),
      '2026-11-10',
    );

    const profile = localModelProfile(free, { searchProvider: 'disabled' });

    expect(profile.id).toBe('local:acme/model');
    expect(profile.roles.copy).toMatchObject({
      model: 'acme/model',
      pricingUsdPerMillion: { input: 0, output: 0, cachedInput: 0 },
      // Its answer's room and its reasoning allowance, capped by its limit.
      maxOutputTokens: 16_000,
    });
    expect(profile.stages).toMatchObject({
      model: 'acme/model',
      contextWindow: 200_000,
    });
  });

  it('should refuse a model whose context window or output limit the catalog does not list', () => {
    expect(() =>
      reportModelOf(listed({ contextWindow: null }), '2026-11-10'),
    ).toThrow(ModelCatalogError);
    expect(() =>
      reportModelOf(listed({ maxOutputTokens: null }), '2026-11-10'),
    ).toThrow(/lists no output limit/);
  });
});
