import { describe, expect, it, vi } from 'vitest';
import {
  defaultProbeBindings,
  RunBindingsError,
  type RunBindings,
} from '../probes/bindings';
import { legacyProbeBindings } from '../probes/legacy-bindings';
import { unlimited } from '../probes/limits';
import { planRun } from '../runner';
import { aeoAuditConfigSchema, runRequestSchema } from '../schema';
import { memoryStores } from '../stores/memory';
import type { CapturedUnitRecord } from '../stores/ports';
import { captureForRun } from './capture';

// ============================================================================
// The bank matched against the bindings (probe adapters spec §4.5): a banked
// answer is reused only when the adapter that captured it, and the model it
// asked when the binding names one, are the unit's frozen binding (open
// models spec §8). A mismatch stops the run before any dispatch; the unit is
// never probed again silently under another binding.
// ============================================================================

const config = aeoAuditConfigSchema.parse({
  reportKey: 'bank-bindings',
  slug: 'bank-bindings-abcde',
  brand: { name: 'Acme Files', domain: 'acme.example', aliases: [] },
  competitors: [{ name: 'Rival Files', domain: 'rival.example' }],
  sections: [
    {
      key: 'file_stores',
      prompts: [{ id: 'fs1', text: 'Which store?', category: 'comparison' }],
    },
  ],
  moneyPages: [],
  productBrief: 'A fictional file store used only in tests.',
  chatProbes: { runsPerPrompt: 1 },
});
const request = runRequestSchema.parse({
  reportKey: 'bank-bindings',
  runId: 'run-2',
  surfaces: ['chatgpt'],
});
const plan = planRun(config, request);

const bankedWith = ({
  adapter,
  requestedModel = 'openai/gpt-5.4-mini',
  metadata = true,
}: {
  adapter?: string;
  requestedModel?: string;
  metadata?: boolean;
}): CapturedUnitRecord => {
  const [unit] = plan.units;

  if (!unit) {
    throw new Error('The plan has no unit.');
  }

  return {
    status: 'captured',
    ...unit,
    runId: 'run-1',
    capturedAt: '2026-11-01T10:00:00.000Z',
    probe: {
      promptId: unit.promptId,
      promptText: unit.promptText,
      promptCategory: 'comparison',
      modelName: unit.surface,
      runIndex: unit.runIndex,
      text: 'Acme Files.',
    },
    ...(metadata && {
      captureMetadata: {
        requestedModel,
        reportedModel: null,
        parameters: {},
        ...(adapter === undefined ? {} : { adapter }),
      },
    }),
  };
};

const capture = (record: CapturedUnitRecord, bindings: RunBindings) => {
  const captureSection = vi.fn(() => Promise.reject(new Error('dispatched')));

  const result = captureForRun({
    config,
    request,
    plan,
    stores: memoryStores({ probes: [record] }),
    agentCliVersions: { claudeCode: null, codex: null, cursor: null },
    limiter: unlimited(),
    probeDependencies: {
      bindings,
      gateway: () => 'unused',
    },
    logContext: {},
    captureSection,
  });

  return { result, captureSection };
};

describe('capture - captureForRun() and the frozen bindings', () => {
  it('should stop before any dispatch when a banked answer was captured with another adapter', async () => {
    const { result, captureSection } = capture(
      bankedWith({ adapter: 'gateway.openai@2' }),
      legacyProbeBindings,
    );

    await expect(result).rejects.toBeInstanceOf(RunBindingsError);
    await expect(result).rejects.toThrow(
      /chatgpt \(gateway\.openai@1, openai\/gpt-5\.4-mini\)/,
    );
    expect(captureSection).not.toHaveBeenCalled();
  });

  it('should stop before any dispatch when a banked answer asked another model through the same adapter', async () => {
    // Captured under 0.3.0's model; this run asks another one through the
    // adapter 0.3.0 used.
    const { result, captureSection } = capture(bankedWith({}), {
      ...defaultProbeBindings,
      chatgpt: { adapter: 'gateway.openai@1', model: 'openai/gpt-6-luna' },
    });

    await expect(result).rejects.toBeInstanceOf(RunBindingsError);
    await expect(result).rejects.toThrow(
      /chatgpt \(gateway\.openai@1, openai\/gpt-6-luna\)/,
    );
    expect(captureSection).not.toHaveBeenCalled();
  });

  it("should stop before any dispatch when a banked answer was captured under 0.3.0's binding and the run is bound to the 0.4.0 pin", async () => {
    const { result, captureSection } = capture(
      bankedWith({}),
      defaultProbeBindings,
    );

    await expect(result).rejects.toBeInstanceOf(RunBindingsError);
    await expect(result).rejects.toThrow(
      /chatgpt \(gateway\.openai@2, openai\/gpt-6-luna\)/,
    );
    expect(captureSection).not.toHaveBeenCalled();
  });

  it('should reuse a banked answer that names no adapter, as captured with the legacy one', async () => {
    const { result, captureSection } = capture(
      bankedWith({}),
      legacyProbeBindings,
    );

    // The capture itself is refused by the fake section; what matters is
    // that the bank check let the run reach it.
    await expect(result).rejects.not.toBeInstanceOf(RunBindingsError);
    expect(captureSection).toHaveBeenCalled();
  });

  it('should take a banked answer without capture metadata as asked of its legacy model', async () => {
    const legacy = capture(
      bankedWith({ metadata: false }),
      legacyProbeBindings,
    );
    const pinned = capture(
      bankedWith({ metadata: false }),
      defaultProbeBindings,
    );

    await expect(legacy.result).rejects.not.toBeInstanceOf(RunBindingsError);
    await expect(pinned.result).rejects.toBeInstanceOf(RunBindingsError);
    expect(pinned.captureSection).not.toHaveBeenCalled();
  });
});
