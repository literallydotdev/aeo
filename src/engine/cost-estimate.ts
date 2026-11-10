import { authorToolCaps } from '../codex-workflow/author-tools';
import {
  authorSearchLowUsd,
  authorTokens,
  costCoefficientsVersion,
  hostTokensPerAnswer,
  searchUsdPerAnswer,
  stageTokens,
  type Range,
  type TokenRange,
} from '../models/cost-coefficients';
import { tokenCostUsd } from '../models/pricing';
import type { SupportedModel } from '../models/supported-models';
import type { CatalogModel } from '../models/catalog';
import {
  bindingOf,
  probeEstimateUsd,
  type RunBindings,
} from '../probes/bindings';
import type { RunPlan } from '../runner';

// ============================================================================
// What a run or an author session is expected to cost
// (specs/aeo-claude-operator-spec.md §4.2): a low-to-high range per kind of
// paid work, from the plan, the model's list prices and the calibrated
// coefficients. An estimate, never a quote; the cap the operator approves
// is what bounds the spend.
// ============================================================================

export type CostRange = Range<number>;

export type RunCostEstimate = {
  currency: 'USD';
  /** An estimate, labelled as such wherever it is shown. */
  kind: 'estimate';
  model: string;
  coefficientsVersion: number;
  low: number;
  high: number;
  categories: {
    probes: CostRange;
    stages: CostRange;
    hostCalls: CostRange;
    search: CostRange;
  };
  /** The cap to propose to the operator: the high end, rounded up. */
  recommendedCapUsd: number;
};

export type AuthorCostEstimate = Omit<RunCostEstimate, 'categories'> & {
  categories: { stages: CostRange; search: CostRange };
};

const cents = (usd: number): number => {
  return Math.round(usd * 100) / 100;
};

const rangeOf = (low: number, high: number): CostRange => {
  return { low: cents(low), high: cents(high) };
};

/** The high end rounded up to a whole dollar, so the approved amount reads
 * as an amount and never falls just short of the estimate. */
const recommendedCapOf = (high: number): number => {
  return Math.max(1, Math.ceil(high));
};

const tokensCost = (
  model: SupportedModel,
  tokens: TokenRange,
  cachedShare: number,
): number => {
  return tokenCostUsd(model.pricingUsdPerMillion, {
    inputTokens: tokens.input,
    cachedInputTokens: Math.round(tokens.input * cachedShare),
    outputTokens: tokens.output,
  });
};

const scaled = (tokens: TokenRange, factor: number): TokenRange => {
  return { input: tokens.input * factor, output: tokens.output * factor };
};

const sumOf = (ranges: readonly CostRange[]): CostRange => {
  return rangeOf(
    ranges.reduce((total, range) => total + range.low, 0),
    ranges.reduce((total, range) => total + range.high, 0),
  );
};

type EstimateRunOptions = {
  plan: Pick<RunPlan, 'units' | 'probesBySurface'>;
  model: SupportedModel;
  grounding: 'full' | 'extraction_only';
  /** The bindings the run measures with: each surface's probes cost what
   * its bound adapter costs. */
  bindings: RunBindings;
  /** Catalog prices of the bound models the engine has no flat figure
   * for (catalogPricedModels). */
  probeModels?: ReadonlyMap<string, CatalogModel>;
};

/** estimateRunCost estimates a whole run as planned; a resume spends less,
 * because banked answers are never probed again. */
export const estimateRunCost = ({
  plan,
  model,
  grounding,
  bindings,
  probeModels = new Map(),
}: EstimateRunOptions): RunCostEstimate => {
  const answers = plan.units.length;
  const { cachedShare } = stageTokens;

  const probes = sumOf(
    [...plan.probesBySurface].map(([surface, count]) => {
      const usd = probeEstimateUsd(bindingOf(bindings, surface), probeModels);

      return rangeOf(usd.low * count, usd.high * count);
    }),
  );
  // The cheap end assumes the cache serves most input; the dear end less.
  const stages = rangeOf(
    tokensCost(
      model,
      scaled(stageTokens.perAnswer.low, answers),
      cachedShare.high,
    ) + tokensCost(model, stageTokens.perRun.low, cachedShare.high),
    tokensCost(
      model,
      scaled(stageTokens.perAnswer.high, answers),
      cachedShare.low,
    ) + tokensCost(model, stageTokens.perRun.high, cachedShare.low),
  );
  const hostTokens = hostTokensPerAnswer[grounding];
  const hostCalls = rangeOf(
    tokensCost(model, scaled(hostTokens.low, answers), 0),
    tokensCost(model, scaled(hostTokens.high, answers), 0),
  );
  const search =
    grounding === 'full'
      ? rangeOf(
          searchUsdPerAnswer.low * answers,
          searchUsdPerAnswer.high * answers,
        )
      : rangeOf(0, 0);
  const total = sumOf([probes, stages, hostCalls, search]);

  const estimate: RunCostEstimate = {
    currency: 'USD',
    kind: 'estimate',
    model: model.id,
    coefficientsVersion: costCoefficientsVersion,
    low: total.low,
    high: total.high,
    categories: { probes, stages, hostCalls, search },
    recommendedCapUsd: recommendedCapOf(total.high),
  };

  return estimate;
};

/** estimateAuthorCost estimates one author session and its research. */
export const estimateAuthorCost = (
  model: SupportedModel,
): AuthorCostEstimate => {
  const { cachedShare } = stageTokens;
  const stages = rangeOf(
    tokensCost(model, authorTokens.session.low, cachedShare.high),
    tokensCost(model, authorTokens.session.high, cachedShare.low),
  );
  // The research tools refuse to search past their own spend cap.
  const search = rangeOf(authorSearchLowUsd, authorToolCaps.searchSpendUsd);
  const total = sumOf([stages, search]);

  const estimate: AuthorCostEstimate = {
    currency: 'USD',
    kind: 'estimate',
    model: model.id,
    coefficientsVersion: costCoefficientsVersion,
    low: total.low,
    high: total.high,
    categories: { stages, search },
    recommendedCapUsd: recommendedCapOf(total.high),
  };

  return estimate;
};

/** One line a person reads: "$12.40 to $38.10 (estimate)". */
export const describeCostRange = (range: CostRange): string => {
  return `$${range.low.toFixed(2)} to $${range.high.toFixed(2)}`;
};
