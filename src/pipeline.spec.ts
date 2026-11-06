import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AeoPrompt, AeoSurface } from './schema';
import type { ProbeResult } from './probes/probes';
import type { AgentProbeResult } from './probes/agent-clis';
import type { ProbeOutcome } from './probes/outcomes';
import { MemoryProbeStore } from './stores/memory';
import {
  assembleSectionResult,
  captureSectionProbes,
  type AnalyzedRun,
  type SectionCaptureSummary,
  type SectionRunArgs,
} from './pipeline';

// ============================================================================
// Pipeline behavior over mocked probe runners (hardening spec §6.3): coverage
// accounting, lost prompts, failed-unit records, store hits, redelivery
// refusal, and the canonical row order of the assembled section.
// ============================================================================

const chatOutcomes: ProbeOutcome<ProbeResult>[] = [];
const agentOutcomes: ProbeOutcome<AgentProbeResult>[] = [];
let bankers: {
  chat?: (probe: ProbeResult) => Promise<void>;
  agent?: (probe: AgentProbeResult) => Promise<void>;
} = {};

vi.mock(import('./probes/probes'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    runProbesForPrompts: vi.fn(
      async (job: { onResult?: typeof bankers.chat }) => {
        bankers.chat = job.onResult;
        const out: ProbeOutcome<ProbeResult>[] = [];

        for (const outcome of chatOutcomes) {
          if (outcome.status === 'captured') {
            try {
              await job.onResult?.(outcome.probe);
              out.push(outcome);
            } catch (error) {
              out.push({
                status: 'failed',
                unit: outcome.unit,
                kind: 'persistence',
                attempts: 1,
                lastError: String(error),
              });
            }
          } else {
            out.push(outcome);
          }
        }

        return out;
      },
    ),
  };
});

vi.mock(import('./probes/agent-clis'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    runAgentProbesForPrompts: vi.fn(
      async (args: { onResult?: typeof bankers.agent }) => {
        bankers.agent = args.onResult;

        for (const outcome of agentOutcomes) {
          if (outcome.status === 'captured') {
            await args.onResult?.(outcome.probe);
          }
        }

        return {
          outcomes: agentOutcomes,
          rejectedWebToolSurfaces: [] as never[],
        };
      },
    ),
  };
});

const testPrompts: AeoPrompt[] = [
  { id: 'p1', text: 'Best tools?', category: 'comparison' },
  { id: 'p2', text: 'Who leads?', category: 'industry_expert' },
];

const findTestPrompt = (promptId: string) => {
  const prompt = testPrompts.find((p) => p.id === promptId);

  if (!prompt) {
    throw new Error(`Unknown test prompt: ${promptId}.`);
  }

  return prompt;
};

const chat = (
  promptId: string,
  surface: ProbeResult['modelName'],
  runIndex: number,
): ProbeOutcome<ProbeResult> => {
  const prompt = findTestPrompt(promptId);
  const text = `answer ${promptId} ${surface} ${runIndex} https://brand.example/x`;

  return {
    status: 'captured',
    unit: { promptId, surface, runIndex },
    attempts: 1,
    probe: {
      promptId,
      promptText: prompt.text,
      promptCategory: prompt.category,
      modelName: surface,
      runIndex,
      text,
      retrieval: { exposure: 'none', calls: [] },
    },
  };
};

const withText = (
  outcome: ProbeOutcome<ProbeResult>,
  text: string,
): ProbeOutcome<ProbeResult> => {
  if (outcome.status !== 'captured') {
    return outcome;
  }

  return { ...outcome, probe: { ...outcome.probe, text } };
};

const failed = (
  promptId: string,
  surface: ProbeResult['modelName'],
  runIndex: number,
): ProbeOutcome<ProbeResult> => {
  return {
    status: 'failed',
    unit: { promptId, surface, runIndex },
    kind: 'capacity',
    attempts: 3,
    lastError: 'exit 1, stderr: overloaded',
  };
};

const baseArgs = (overrides: Partial<SectionRunArgs> = {}): SectionRunArgs => {
  return {
    sectionKey: 'main',
    brand: { name: 'Brand', domain: 'brand.example', aliases: [] },
    competitors: [{ name: 'Rival', domain: 'rival.example', aliases: [] }],
    prompts: testPrompts,
    geography: 'us',
    language: 'en',
    surfaces: ['perplexity', 'google_ai_overview'],
    agentProbes: { runsPerPrompt: 2 },
    chatProbes: undefined,
    agentCliVersions: { claudeCode: null, codex: null, cursor: null },
    runId: 'RUN1',
    probeStore: new MemoryProbeStore(),
    analysisStore: null,
    logContext: {},
    ...overrides,
  };
};

beforeEach(() => {
  chatOutcomes.length = 0;
  agentOutcomes.length = 0;
  bankers = {};
});

describe('pipeline - captureSectionProbes()', () => {
  it('should account for every planned unit: captured, failed (stored), and lost prompts', async () => {
    chatOutcomes.push(
      chat('p1', 'perplexity', 1),
      chat('p1', 'perplexity', 2),
      failed('p1', 'google_ai_overview', 1),
      failed('p2', 'perplexity', 1),
      failed('p2', 'perplexity', 2),
      failed('p2', 'google_ai_overview', 1),
    );

    const probeStore = new MemoryProbeStore();
    const args = baseArgs({ probeStore });

    const capture = await captureSectionProbes(args);

    expect(capture.probes).toHaveLength(2);
    expect(capture.coverage).toEqual([
      { surface: 'perplexity', planned: 4, captured: 2 },
      { surface: 'google_ai_overview', planned: 2, captured: 0 },
    ]);

    expect(capture.lostPromptIds).toEqual(['p2']);
    expect(capture.unitFailures).toHaveLength(4);

    const records = await probeStore.list();
    expect(records.filter((r) => r.status === 'captured')).toHaveLength(2);
    const stored = records.filter((r) => r.status === 'failed');
    expect(stored).toHaveLength(4);
    expect(stored[0]).toMatchObject({
      kind: 'capacity',
      attempts: 3,
      runId: 'RUN1',
      sectionKey: 'main',
    });

    // A failed record never satisfies the next run's lookup.
    expect(
      (
        await probeStore.get({
          sectionKey: 'main',
          promptId: 'p2',
          promptText: 'Who leads?',
          surface: 'perplexity',
          runIndex: 1,
        })
      )?.status,
    ).toBe('failed');
  });

  it('should reuse stored captures and only run the missing units', async () => {
    const store = new MemoryProbeStore();
    const stored = chat('p1', 'perplexity', 1);

    if (stored.status !== 'captured') {
      return;
    }

    await store.put({
      status: 'captured',
      sectionKey: 'main',
      promptId: 'p1',
      promptText: 'Best tools?',
      surface: 'perplexity',
      runIndex: 1,
      capturedAt: '2026-09-01T00:00:00.000Z',
      probe: stored.probe,
    });

    chatOutcomes.push(
      chat('p1', 'perplexity', 2),
      chat('p1', 'google_ai_overview', 1),
      chat('p2', 'perplexity', 1),
      chat('p2', 'perplexity', 2),
      chat('p2', 'google_ai_overview', 1),
    );

    const { runProbesForPrompts } = await import('./probes/probes');
    const capture = await captureSectionProbes(baseArgs({ probeStore: store }));
    expect(capture.probes).toHaveLength(6);
    const job = vi.mocked(runProbesForPrompts).mock.calls.at(-1)?.[0];
    expect(
      job?.filter?.({ promptId: 'p1', surface: 'perplexity', runIndex: 1 }),
    ).toBe(false);

    expect(
      job?.filter?.({ promptId: 'p1', surface: 'perplexity', runIndex: 2 }),
    ).toBe(true);

    // Only fresh captures feed the retrieval-capture guard.
    expect(capture.freshChatRetrieval).toHaveLength(5);
  });

  it('should refuse a redelivered capture without losing this run’s copy', async () => {
    const store = new MemoryProbeStore();
    chatOutcomes.push(
      withText(chat('p1', 'perplexity', 1), 'first'),
      chat('p1', 'perplexity', 2),
      chat('p1', 'google_ai_overview', 1),
      chat('p2', 'perplexity', 1),
      chat('p2', 'perplexity', 2),
      chat('p2', 'google_ai_overview', 1),
    );

    // Simulate the banker being handed the same unit twice: the mock calls
    // onResult once per outcome; a duplicate outcome is a second delivery.
    chatOutcomes.push(withText(chat('p1', 'perplexity', 1), 'second'));
    const capture = await captureSectionProbes(baseArgs({ probeStore: store }));
    expect(capture.probes.length).toBeGreaterThan(0);
    const hit = await store.get({
      sectionKey: 'main',
      promptId: 'p1',
      promptText: 'Best tools?',
      surface: 'perplexity',
      runIndex: 1,
    });

    expect(hit?.status === 'captured' && hit.probe.text).toBe('first');
  });
});

describe('pipeline - assembleSectionResult()', () => {
  const getTestPromptId = (promptIdx: number) => {
    const prompt = testPrompts[promptIdx];

    if (!prompt) {
      throw new Error(`No test prompt at index: ${promptIdx}.`);
    }

    return prompt.id;
  };

  const judged = (
    promptIdx: number,
    surface: AeoSurface,
    runIndex: number,
  ): AnalyzedRun => {
    return {
      promptIdx,
      promptId: getTestPromptId(promptIdx),
      surface,
      runIndex,
      clientMentioned: false,
      clientCited: false,
      clientPosition: 'absent',
      clientSentiment: 'neutral',
      contextSnippet: null,
      responseText: `answer ${promptIdx} ${surface} ${runIndex}`,
      citedUrls: [],
      competitorMentions: [
        { domain: 'rival.example', mentioned: false, cited: false },
      ],
      allMentionedBrands: [],
    };
  };

  it('should order rows canonically whatever order the judged runs arrive in', () => {
    const runs = [
      judged(1, 'google_ai_overview', 1),
      judged(1, 'perplexity', 2),
      judged(0, 'google_ai_overview', 1),
      judged(0, 'perplexity', 2),
      judged(1, 'perplexity', 1),
      judged(0, 'perplexity', 1),
    ];

    const capture: SectionCaptureSummary = {
      probeCount: runs.length,
      coverage: [
        { surface: 'perplexity', planned: 4, captured: 4 },
        { surface: 'google_ai_overview', planned: 2, captured: 2 },
      ],
      lostPromptIds: [],
      unitFailures: [],
      rejectedWebToolSurfaces: [],
      freshChatRetrieval: [],
      freshAgentRetrieval: [],
    };

    const result = assembleSectionResult(baseArgs(), capture, [
      {
        promptId: 'p2',
        runs: runs.filter((r) => r.promptIdx === 1),
        cached: false,
        error: null,
      },
      {
        promptId: 'p1',
        runs: runs.filter((r) => r.promptIdx === 0),
        cached: false,
        error: null,
      },
    ]);

    expect(
      result.visibility.matrix.map(
        (r) => `${r.promptIdx}:${r.surface}:${r.runIndex}`,
      ),
    ).toEqual([
      '0:perplexity:1',
      '0:perplexity:2',
      '0:google_ai_overview:1',
      '1:perplexity:1',
      '1:perplexity:2',
      '1:google_ai_overview:1',
    ]);
  });

  it('should list visibility surfaces in canonical order, NOT in the order they were selected', () => {
    const args = baseArgs({
      surfaces: ['cursor', 'perplexity', 'claude_code', 'chatgpt'],
    });

    const capture: SectionCaptureSummary = {
      probeCount: 0,
      coverage: [],
      lostPromptIds: [],
      unitFailures: [],
      rejectedWebToolSurfaces: [],
      freshChatRetrieval: [],
      freshAgentRetrieval: [],
    };

    const result = assembleSectionResult(args, capture, []);

    expect(result.visibility.surfaces).toEqual([
      'chatgpt',
      'perplexity',
      'claude_code',
      'cursor',
    ]);
  });
});
