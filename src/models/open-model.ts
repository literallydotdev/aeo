import { ModelCatalogError, type CatalogModel } from './catalog';
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
 * it; a model that offers none is asked for none. */
const preferredEffort = 'high';

/**
 * reportModelOf is the entry a run uses for a model the engine has none of
 * its own for: its catalog prices, as read on `pricedOn`, and settings
 * derived from what the catalog says of it.
 */
export const reportModelOf = (
  model: CatalogModel,
  pricedOn: string,
): SupportedModel => {
  const { contextWindow, maxOutputTokens } = model;

  if (contextWindow === null || maxOutputTokens === null) {
    throw new ModelCatalogError(
      `${model.id} lists no ${contextWindow === null ? 'context window' : 'output limit'} on the gateway's model list. The Codex stages must be told both, so this model cannot write a report; it can still be measured as a surface.`,
    );
  }

  const thinksHard = model.reasoningEfforts.includes(preferredEffort);

  return {
    id: model.id,
    label: model.label,
    pricingUsdPerMillion: model.pricingUsdPerMillion,
    pricingCheckedAt: pricedOn,
    contextWindow,
    maxOutputTokens,
    thinkingInOutput: model.reasoning,
    providerOptions: thinksHard
      ? { gateway: { reasoning: { effort: preferredEffort } } }
      : {},
    // Codex is always given an effort; a model without `high` gets the
    // lowest the stage runtime accepts.
    stageReasoningEffort: thinksHard ? preferredEffort : 'medium',
    stageRuntimeVerifiedAt: null,
  };
};
