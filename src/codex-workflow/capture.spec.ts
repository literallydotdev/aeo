import { describe, expect, it, vi } from 'vitest';
import { defaultProbeBindings, RunBindingsError } from '../probes/bindings';
import { unlimited } from '../probes/limits';
import { planRun } from '../runner';
import { aeoAuditConfigSchema, runRequestSchema } from '../schema';
import { memoryStores } from '../stores/memory';
import type { CapturedUnitRecord } from '../stores/ports';
import { captureForRun } from './capture';

// ============================================================================
// The bank matched against the bindings (probe adapters spec §4.5): a banked
// answer is reused only when the adapter that captured it is the unit's
// frozen binding. A mismatch stops the run before any dispatch; the unit is
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

const bankedWith = (adapter: string | undefined): CapturedUnitRecord => {
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
    captureMetadata: {
      requestedModel: 'openai/gpt-5.4-mini',
      reportedModel: null,
      parameters: {},
      ...(adapter === undefined ? {} : { adapter }),
    },
  };
};

const capture = (record: CapturedUnitRecord) => {
  const captureSection = vi.fn(() => Promise.reject(new Error('dispatched')));

  const result = captureForRun({
    config,
    request,
    plan,
    stores: memoryStores({ probes: [record] }),
    agentCliVersions: { claudeCode: null, codex: null, cursor: null },
    limiter: unlimited(),
    probeDependencies: {
      bindings: defaultProbeBindings,
      gateway: () => 'unused',
    },
    logContext: {},
    captureSection,
  });

  return { result, captureSection };
};

describe('capture - captureForRun() and the frozen bindings', () => {
  it('should stop before any dispatch when a banked answer was captured with another adapter', async () => {
    const { result, captureSection } = capture(bankedWith('gateway.openai@2'));

    await expect(result).rejects.toBeInstanceOf(RunBindingsError);
    await expect(result).rejects.toThrow(/chatgpt \(gateway\.openai@1\)/);
    expect(captureSection).not.toHaveBeenCalled();
  });

  it('should reuse a banked answer that names no adapter, as captured with the legacy one', async () => {
    const { result, captureSection } = capture(bankedWith(undefined));

    // The capture itself is refused by the fake section; what matters is
    // that the bank check let the run reach it.
    await expect(result).rejects.not.toBeInstanceOf(RunBindingsError);
    expect(captureSection).toHaveBeenCalled();
  });
});
