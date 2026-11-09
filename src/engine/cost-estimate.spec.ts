import { describe, expect, it } from 'vitest';
import {
  chargedTotal,
  createMemoryModelAccounting,
} from '../models/accounting';
import { authorToolCaps } from '../codex-workflow/author-tools';
import { probeUsd, sessionReservation } from '../models/cost-coefficients';
import { tokenCostUsd } from '../models/pricing';
import { defaultProbeBindings } from '../probes/bindings';
import {
  resolveSupportedModel,
  supportedModels,
} from '../models/supported-models';
import type { AeoSurface } from '../schema';
import calibrationFixture from '../models/__fixtures__/calibration-runs.json';
import { estimateAuthorCost, estimateRunCost } from './cost-estimate';

const planOf = (answers: number) => {
  const units = Array.from({ length: answers }, (_, index) => ({ index }));
  const probesBySurface = new Map<AeoSurface, number>([
    ['chatgpt', answers / 4],
    ['gemini', answers / 4],
    ['claude', answers / 4],
    ['perplexity', answers / 4],
  ]);

  return { units, probesBySurface } as never;
};

/** A recorded run's sessions and host calls, reserved and settled through a
 * ledger at `model`'s list prices: what the run would have cost on it. */
const replayed = async (
  run: (typeof calibrationFixture.runs)[number],
  model: ReturnType<typeof resolveSupportedModel>,
) => {
  const ledger = createMemoryModelAccounting({
    maxUsd: 10_000,
    maxTokens: 1_000_000_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });
  const charge = async (
    callId: string,
    role: string,
    usage: { input: number; cachedInput: number; output: number },
  ) => {
    await ledger.reserve({
      callId,
      role,
      reservedUsd: 0,
      inputTokens: 0,
      maxOutputTokens: 0,
    });
    await ledger.settle(callId, {
      costUsd: tokenCostUsd(model.pricingUsdPerMillion, {
        inputTokens: usage.input,
        cachedInputTokens: usage.cachedInput,
        outputTokens: usage.output,
      }),
    });

    return chargedTotal([ledger.state.calls[callId] ?? never()]).usd;
  };

  const stages =
    (await charge('analyze', 'stage:analyze', run.stageTokens.perAnswer)) +
    (await charge('write', 'stage:write', run.stageTokens.perRun));
  const hostCalls = await charge('host', 'perception', {
    ...run.hostTokens,
    cachedInput: 0,
  });

  return { stages, hostCalls };
};

const never = (): never => {
  throw new Error('Expected a settled call in the test ledger.');
};

describe('cost-estimate - estimateRunCost()', () => {
  it("should price each surface's probes at its bound adapter, under coefficients version 2", () => {
    const plan = {
      units: Array.from({ length: 4 }, (_, index) => ({ index })),
      probesBySurface: new Map<AeoSurface, number>([['chatgpt', 4]]),
    } as never;
    const priced = (bindings: typeof defaultProbeBindings) => {
      return estimateRunCost({
        plan,
        model: resolveSupportedModel(),
        grounding: 'extraction_only',
        bindings,
      });
    };

    const defaults = priced(defaultProbeBindings);
    const rebound = priced({
      ...defaultProbeBindings,
      chatgpt: { adapter: 'gateway.anthropic@1', model: 'anthropic/test-1' },
    });

    expect(defaults.coefficientsVersion).toBe(2);
    expect(defaults.categories.probes).toEqual({
      low: probeUsd['gateway.openai@1'].low * 4,
      high: probeUsd['gateway.openai@1'].high * 4,
    });
    expect(rebound.categories.probes).toEqual({
      low: probeUsd['gateway.anthropic@1'].low * 4,
      high: probeUsd['gateway.anthropic@1'].high * 4,
    });
  });

  it('should estimate every category, with a cap at the high end', () => {
    const estimate = estimateRunCost({
      plan: planOf(32),
      bindings: defaultProbeBindings,
      model: resolveSupportedModel(),
      grounding: 'full',
    });

    const ranges = Object.values(estimate.categories);

    expect(estimate.kind).toBe('estimate');
    expect(Object.keys(estimate.categories)).toEqual([
      'probes',
      'stages',
      'hostCalls',
      'search',
    ]);
    expect(ranges.filter((range) => range.low <= 0)).toEqual([]);
    expect(ranges.filter((range) => range.high < range.low)).toEqual([]);
    expect(estimate.recommendedCapUsd).toBeGreaterThanOrEqual(estimate.high);
  });

  it.each(
    supportedModels.flatMap((model) =>
      calibrationFixture.runs.map((run) => [run.name, model.id] as const),
    ),
  )(
    'should contain the replayed cost of recorded run %s on %s',
    async (name, modelId) => {
      const run =
        calibrationFixture.runs.find((entry) => entry.name === name) ?? never();
      const model = resolveSupportedModel(modelId);
      const estimate = estimateRunCost({
        plan: planOf(run.answers),
        bindings: defaultProbeBindings,
        model,
        grounding: run.grounding === 'full' ? 'full' : 'extraction_only',
      });

      const cost = await replayed(run, model);

      expect(cost.stages).toBeGreaterThanOrEqual(
        estimate.categories.stages.low,
      );
      expect(cost.stages).toBeLessThanOrEqual(estimate.categories.stages.high);
      expect(cost.hostCalls).toBeGreaterThanOrEqual(
        estimate.categories.hostCalls.low,
      );
      expect(cost.hostCalls).toBeLessThanOrEqual(
        estimate.categories.hostCalls.high,
      );
    },
  );

  it('should charge nothing for search under extraction-only grounding', () => {
    const estimate = estimateRunCost({
      plan: planOf(16),
      bindings: defaultProbeBindings,
      model: resolveSupportedModel(),
      grounding: 'extraction_only',
    });

    expect(estimate.categories.search).toEqual({ low: 0, high: 0 });
  });
});

describe('cost-estimate - reservations under the recommended cap', () => {
  it.each(supportedModels.map((model) => [model.id] as const))(
    'should admit the author session and its research allowance under the recommended author cap on %s',
    (modelId) => {
      const model = resolveSupportedModel(modelId);
      const session = tokenCostUsd(
        model.pricingUsdPerMillion,
        sessionReservation({ cost: 'brief', answers: 0 }),
      );

      const reserved = session + authorToolCaps.searchSpendUsd;

      expect(reserved).toBeLessThanOrEqual(
        estimateAuthorCost(model).recommendedCapUsd,
      );
    },
  );

  it.each(supportedModels.map((model) => [model.id] as const))(
    "should reserve the write session within the estimate's high end for the stages on %s",
    (modelId) => {
      const model = resolveSupportedModel(modelId);
      const estimate = estimateRunCost({
        plan: planOf(4),
        bindings: defaultProbeBindings,
        model,
        grounding: 'full',
      });

      const write = tokenCostUsd(
        model.pricingUsdPerMillion,
        sessionReservation({ cost: 'report', answers: 0 }),
      );

      expect(write).toBeLessThanOrEqual(estimate.categories.stages.high);
    },
  );
});

describe('cost-estimate - estimateAuthorCost()', () => {
  it('should estimate one session and its capped research as a small range', () => {
    const estimate = estimateAuthorCost(resolveSupportedModel());

    expect(estimate.low).toBeGreaterThan(0);
    expect(estimate.high).toBeLessThan(10);
    expect(estimate.recommendedCapUsd).toBeGreaterThanOrEqual(estimate.high);
  });
});
