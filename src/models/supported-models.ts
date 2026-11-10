import { z } from 'zod';
import {
  codexStageModelSchema,
  internalModelRoleSchema,
  modelPricingSchema,
} from './profiles';

// ============================================================================
// The models a local run may judge, research and write with
// (specs/aeo-claude-operator-spec.md §4.1): one gateway model runs every
// text role and the Codex stages. Each entry holds public facts only (list
// prices with the date they were checked, the context window, the output
// ceiling) and what the engine has verified about it. Adding or changing a
// model is a release of the package; a run records the profile built from
// the entry it resolved (src/models/local-profile.ts).
// ============================================================================

export const supportedModelSchema = z
  .object({
    /** The gateway model ID, as audit.json's `model` names it. */
    id: z.string().min(1),
    label: z.string().min(1),
    pricingUsdPerMillion: modelPricingSchema,
    pricingCheckedAt: z.iso.date(),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    /** The model's hidden reasoning is billed inside the output allowance,
     * so every role is given room to think on top of its answer. */
    thinkingInOutput: z.boolean(),
    providerOptions: internalModelRoleSchema.shape.providerOptions,
    stageReasoningEffort: codexStageModelSchema.shape.reasoningEffort,
    /** The date a real batch ran through the gateway on Codex's Responses
     * wire API with this model (the spike, spec §4.3); null until then. */
    stageRuntimeVerifiedAt: z.iso.date().nullable(),
  })
  .strict();

export type SupportedModel = z.infer<typeof supportedModelSchema>;

export const supportedModels: readonly SupportedModel[] = [
  {
    id: 'anthropic/claude-opus-5.5',
    label: 'Claude Opus 5.5',
    pricingUsdPerMillion: { input: 4, output: 20, cachedInput: 0.2 },
    pricingCheckedAt: '2026-11-09',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinkingInOutput: true,
    providerOptions: { gateway: { reasoning: { effort: 'high' } } },
    stageReasoningEffort: 'high',
    stageRuntimeVerifiedAt: '2026-11-04',
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    label: 'Claude Sonnet 5.5',
    pricingUsdPerMillion: { input: 2, output: 10, cachedInput: 0.1 },
    pricingCheckedAt: '2026-11-09',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinkingInOutput: true,
    providerOptions: { gateway: { reasoning: { effort: 'high' } } },
    stageReasoningEffort: 'high',
    stageRuntimeVerifiedAt: '2026-11-04',
  },
];

/** The model a run uses when audit.json names none: the strongest the
 * engine supports, because judgment and copy quality are the report. */
export const recommendedModelId = 'anthropic/claude-opus-5.5';

/** The supported models as a list a person or an agent can read. */
export const describeSupportedModels = (): string[] => {
  const lines = supportedModels.map((model) => {
    const { input, cachedInput, output } = model.pricingUsdPerMillion;
    const recommended = model.id === recommendedModelId ? ' (recommended)' : '';

    return `${model.id}${recommended}: ${model.label}, $${input} in / $${cachedInput} cached / $${output} out per million tokens (checked ${model.pricingCheckedAt})`;
  });

  return lines;
};

/** findSupportedModel returns the list's entry for a gateway model ID. */
export const findSupportedModel = (id: string): SupportedModel | undefined => {
  return supportedModels.find((model) => model.id === id);
};

export class UnsupportedModelError extends Error {
  constructor(id: string) {
    super(
      [
        `${id} is not one of the models literally-aeo ships settings for. Any other gateway model is priced from the gateway's model list first (resolveReportModel). Its own models:`,
        ...describeSupportedModels().map((line) => `  ${line}`),
      ].join('\n'),
    );
    this.name = 'UnsupportedModelError';
  }
}

/** resolveSupportedModel returns the engine's own entry for the named
 * model, or for the recommended one when none is named. A model it has no
 * entry for is refused here: a run resolves one through the catalog
 * (resolveReportModel). */
export const resolveSupportedModel = (
  id: string = recommendedModelId,
): SupportedModel => {
  const model = findSupportedModel(id);

  if (!model) {
    throw new UnsupportedModelError(id);
  }

  return model;
};
