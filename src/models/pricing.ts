import type { ModelPricing } from './profiles';

// ============================================================================
// What tokens cost at a model's list prices. Cached input is billed at the
// cached price; the rest of the input at the input price. Cache writes are
// billed as input: an approximation that slightly understates the models
// that charge a premium for them, which the estimate's range absorbs.
// ============================================================================

export type TokenUsage = {
  inputTokens: number;
  /** Part of inputTokens, served from the provider's cache. */
  cachedInputTokens: number;
  outputTokens: number;
};

export const tokenCostUsd = (
  pricing: ModelPricing,
  usage: TokenUsage,
): number => {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;

  const usd =
    (uncached * pricing.input +
      cached * pricing.cachedInput +
      usage.outputTokens * pricing.output) /
    1_000_000;

  return usd;
};
