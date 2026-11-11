import { ModelCatalogError, type CatalogModel } from './catalog';
import type { ReasoningEffort } from './profiles';
import type { SupportedModel } from './supported-models';

// ============================================================================
// Any gateway language model as the report model (open models spec §6). The
// engine ships verified settings for the models on its own list; any other
// model runs on settings derived from its catalog entry, below, and says it
// was never verified on the Codex stage runtime. Nothing about the model is
// judged: it is refused only when the engine cannot tell Codex its context
// window or bound a call's output.
// ============================================================================

/** The effort every role and the Codex stages ask of a model that offers
 * it, unless the audit names another; a model that offers none is asked
 * for none. */
const preferredEffort = 'high';

/**
 * reportModelOf is the entry a run uses for a model the engine has none of
 * its own for: its catalog prices, as read on `pricedOn`, and settings
 * derived from what the catalog says of it. An `effort` the audit names
 * must be one the catalog lists for the model.
 */
export const reportModelOf = (
  model: CatalogModel,
  pricedOn: string,
  effort?: ReasoningEffort,
): SupportedModel => {
  const { contextWindow, maxOutputTokens } = model;

  if (contextWindow === null || maxOutputTokens === null) {
    throw new ModelCatalogError(
      `${model.id} lists no ${contextWindow === null ? 'context window' : 'output limit'} on the gateway's model list. The Codex stages must be told both, so this model cannot write a report; it can still be measured as a surface.`,
    );
  }

  if (effort !== undefined && !model.reasoningEfforts.includes(effort)) {
    const offered =
      model.reasoningEfforts.length === 0
        ? 'it lists no reasoning effort'
        : `it lists ${model.reasoningEfforts.join(', ')}`;

    throw new ModelCatalogError(
      `${model.id} is not offered at effort ${JSON.stringify(effort)} on the gateway's model list: ${offered}. Please set modelEffort to one of those, or leave it out.`,
    );
  }

  const asked =
    effort ??
    (model.reasoningEfforts.includes(preferredEffort)
      ? preferredEffort
      : undefined);

  return {
    id: model.id,
    label: model.label,
    pricingUsdPerMillion: model.pricingUsdPerMillion,
    pricingCheckedAt: pricedOn,
    contextWindow,
    maxOutputTokens,
    thinkingInOutput: model.reasoning,
    providerOptions:
      asked === undefined ? {} : { gateway: { reasoning: { effort: asked } } },
    // Codex is always given an effort; a model that offers none gets a
    // moderate one.
    stageReasoningEffort: asked ?? 'medium',
    stageRuntimeVerifiedAt: null,
  };
};
