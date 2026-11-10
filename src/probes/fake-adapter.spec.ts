import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleSchemaVersion } from '../bundle/contracts';
import { readJournal } from '../bundle/journal';
import {
  openRecorder,
  probeTraceOf,
  recordedOperationKinds,
} from '../bundle/recorder';
import {
  assessTraceCoverage,
  capturedAnswerOf,
} from '../bundle/trace-coverage';
import { createMemoryModelAccounting } from '../models/accounting';
import { probeUsd } from '../models/cost-coefficients';
import { captureSectionProbes } from '../pipeline';
import { aeoAuditConfigSchema } from '../schema';
import { MemoryProbeStore } from '../stores/memory';
import type { CapturedUnitRecord } from '../stores/ports';
import type { ProbeAdapter } from './adapter';
import { defaultProbeBindings, type ChatAdapterRegistry } from './bindings';
import { chargedProbeTrace } from './charged-trace';

// ============================================================================
// Adding an adapter (probe adapters spec §3.1, §8): a fake adapter,
// registered for one surface, is captured, reserved, journaled, banked,
// resumed and covered by the engine as it is, with nothing changed outside
// this test.
// ============================================================================

const config = aeoAuditConfigSchema.parse({
  reportKey: 'fake-adapter',
  slug: 'fake-adapter-abcde',
  brand: { name: 'Acme Files', domain: 'acme.example', aliases: [] },
  competitors: [{ name: 'Rival Files', domain: 'rival.example' }],
  sections: [
    {
      key: 'file_stores',
      prompts: [
        { id: 'fs1', text: 'Which store?', category: 'comparison' },
        { id: 'fs2', text: 'Which is cheapest?', category: 'comparison' },
      ],
    },
  ],
  moneyPages: [],
  productBrief: 'A fictional file store used only in tests.',
  chatProbes: { runsPerPrompt: 1 },
});

const [section] = config.sections;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-fake-adapter-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('probes - a registered adapter', () => {
  it('should be captured, reserved, journaled, banked, resumed and covered with no engine change', async () => {
    if (!section) {
      throw new Error('The config has no section.');
    }

    const probe = vi.fn<ProbeAdapter['probe']>((promptText) =>
      Promise.resolve({
        answerText: `Acme Files answers: ${promptText}`,
        sources: { format: 'none' },
        retrieval: { exposure: 'full', calls: [] },
        servedModel: 'fake-model-2026',
        reportedCostUsd: 0.004,
      }),
    );
    const registry: ChatAdapterRegistry = (surface, binding) =>
      surface === 'chatgpt'
        ? {
            id: binding.adapter,
            model: binding.model,
            surface,
            observes: { retrieval: 'full', servedModel: 'raw' },
            settings: [],
            pool: 'gateway',
            retry: 'chat',
            estimateUsd: probeUsd[binding.adapter],
            billing: 'metered',
            resolvesRedirects: false,
            request: (promptText) => ({
              prompt: promptText,
              parameters: { vendor: 'fake' },
            }),
            probe,
            classifyError: (error) => ({
              kind: 'cli_error',
              message: String(error),
            }),
          }
        : undefined;
    const ledger = createMemoryModelAccounting({
      maxUsd: 10,
      maxTokens: 1_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });
    const recorder = await openRecorder(root, {
      origin: 'local',
      runId: 'fake-run',
      measurementDigest: '0'.repeat(64),
      planDigest: '0'.repeat(64),
      observes: recordedOperationKinds,
    });
    const probeStore = new MemoryProbeStore();
    const capture = () => {
      return captureSectionProbes({
        sectionKey: section.key,
        brand: config.brand,
        competitors: config.competitors,
        prompts: section.prompts,
        geography: config.geography,
        language: config.language,
        surfaces: ['chatgpt'],
        agentProbes: config.agentProbes,
        chatProbes: config.chatProbes,
        agentCliVersions: { claudeCode: null, codex: null, cursor: null },
        runId: 'fake-run',
        probeStore,
        analysisStore: null,
        trace: chargedProbeTrace(probeTraceOf(recorder, 'probe'), ledger, {
          bindings: defaultProbeBindings,
        }).trace,
        probeDependencies: {
          bindings: defaultProbeBindings,
          gateway: () => 'unused',
          registry,
        },
        logContext: {},
      });
    };

    const first = await capture();
    const resumed = await capture();

    const banked = (await probeStore.list()).filter(
      (record): record is CapturedUnitRecord => record.status === 'captured',
    );
    const events = readJournal(
      await readFile(path.join(root, 'JOURNAL', 'run', 'events.jsonl'), 'utf8'),
    ).events;
    const started = events.filter(
      (event) => event.type === 'operation_started',
    );

    // Captured and banked: one answer per planned unit.
    expect(first.coverage).toEqual([
      { surface: 'chatgpt', planned: 2, captured: 2 },
    ]);
    expect(banked.map((record) => record.probe.text).sort()).toEqual([
      'Acme Files answers: Which is cheapest?',
      'Acme Files answers: Which store?',
    ]);
    expect(banked[0]?.captureMetadata?.reportedModel).toBe('fake-model-2026');
    // Resumed: the second capture reuses the bank and asks nothing.
    expect(probe).toHaveBeenCalledTimes(2);
    expect(resumed.coverage).toEqual(first.coverage);
    // Reserved and settled at the cost the adapter reported.
    expect(
      Object.values(ledger.state.calls).map((call) => call.usage?.costUsd),
    ).toEqual([0.004, 0.004]);
    // Journaled with the adapter and its request.
    expect(started.map((event) => event.payload.details)).toEqual([
      expect.objectContaining({ adapter: 'gateway.openai@1' }),
      expect.objectContaining({ adapter: 'gateway.openai@1' }),
    ]);
    // Covered: a probe operation returned every banked answer.
    expect(
      assessTraceCoverage({
        events,
        captured: banked.map(capturedAnswerOf),
        derived: false,
        bundleSchema: bundleSchemaVersion,
      }).gaps,
    ).toEqual([]);
  });
});
