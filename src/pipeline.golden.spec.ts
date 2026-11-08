import { rm } from 'node:fs/promises';
import type * as GatewayModule from '@ai-sdk/gateway';
import type * as AiModule from 'ai';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  vi,
} from 'vitest';
import { buildCaptureManifest } from './capture-manifest';
import { captureSectionProbes } from './pipeline';
import {
  answeredStream,
  createFakeCliHost,
  createFakeNetwork,
  expectGolden,
  readGolden,
  stubAgentEnvironment,
  type FakeCliHost,
} from './probes/__fixtures__/golden-harness';
import type { ProbeAttemptStart } from './probes/probe-trace';
import { aeoAuditConfigSchema, type AeoSurface } from './schema';
import { MemoryProbeStore } from './stores/memory';
import type { CapturedUnitRecord } from './stores/ports';

// ============================================================================
// Golden pins of what a capture records per surface (probe adapters spec
// §7, phase 1): each banked record's captureMetadata, and the capture
// manifest's probeProfile and digests built from those records. Every
// surface runs through the real probe layer: chat surfaces over a mocked
// AI SDK and a fake DataForSEO, coding agents through the fake CLI. The
// expected values in probes/__fixtures__/golden/capture-records.json record
// 0.2.2; a failing pin is a behaviour change to find, never a file to
// regenerate.
// ============================================================================

type StreamOptions = { model: unknown };

const provider = vi.hoisted(() => ({
  streamText: vi.fn<(options: StreamOptions) => unknown>(),
}));

vi.mock('ai', async () => ({
  ...(await vi.importActual<typeof AiModule>('ai')),
  streamText: (options: StreamOptions) => provider.streamText(options),
}));

vi.mock('@ai-sdk/gateway', async () => ({
  ...(await vi.importActual<typeof GatewayModule>('@ai-sdk/gateway')),
  gateway: (id: string) => `gateway:${id}`,
}));

const surfaces: AeoSurface[] = [
  'chatgpt',
  'gemini',
  'claude',
  'perplexity',
  'google_ai_overview',
  'claude_code',
  'codex',
  'cursor',
];

const config = aeoAuditConfigSchema.parse({
  reportKey: 'golden-capture',
  slug: 'golden-capture-abcde',
  brand: { name: 'Acme Files', domain: 'acme.example', aliases: [] },
  competitors: [{ name: 'Rival Files', domain: 'rival.example' }],
  sections: [
    {
      key: 'file_stores',
      prompts: [
        {
          id: 'fs1',
          text: 'Which managed file store suits a small engineering team?',
          category: 'product_recommendation',
        },
      ],
    },
  ],
  agentProbes: { runsPerPrompt: 1 },
  chatProbes: { runsPerPrompt: 1 },
  geography: 'us',
  language: 'en',
  moneyPages: ['https://acme.example/pricing'],
  productBrief: 'A fictional file store used only in tests.',
});

// The model each chat surface's provider names in its response, or none.
const servedModels: Record<string, string | undefined> = {
  'gateway:openai/gpt-5.4-mini': 'openai/gpt-5.4-mini-2026-03-17',
  'gateway:google/gemini-3-flash': undefined,
  'gateway:anthropic/claude-sonnet-4.5': 'anthropic/claude-sonnet-4.5',
  'gateway:perplexity/sonar-pro': 'perplexity/sonar-pro-2026-10',
};

let host: FakeCliHost;
let golden: Record<string, unknown>;

beforeAll(async () => {
  host = await createFakeCliHost();
  golden = (await readGolden('capture-records.json')) as Record<
    string,
    unknown
  >;
  stubAgentEnvironment(host);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(host.root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-08T12:00:00.000Z'));
  vi.stubEnv('DATAFORSEO_LOGIN', 'golden-login');
  vi.stubEnv('DATAFORSEO_PASSWORD', 'golden-password');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pipeline - captureSectionProbes() golden pins', () => {
  it('should record each surface capture metadata and manifest probe profile', async () => {
    provider.streamText.mockImplementation((options) =>
      answeredStream({
        steps: [],
        text: `An answer from ${String(options.model)}.`,
        sources: [],
        finishReason: 'stop',
        toolCalls: [],
        response: {
          modelId: servedModels[String(options.model)],
          messages: [],
        },
        providerMetadata: undefined,
      }),
    );
    vi.stubGlobal(
      'fetch',
      createFakeNetwork({
        serp: {
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              result: [
                {
                  items: [{ type: 'ai_overview', markdown: 'An AI Overview.' }],
                },
              ],
            },
          ],
        },
      }).fetch,
    );

    const store = new MemoryProbeStore();
    const starts: ProbeAttemptStart[] = [];
    const [section] = config.sections;

    if (!section) {
      throw new Error('The golden config has no section.');
    }

    const capture = await captureSectionProbes({
      sectionKey: section.key,
      brand: config.brand,
      competitors: config.competitors,
      prompts: section.prompts,
      geography: config.geography,
      language: config.language,
      surfaces,
      agentProbes: config.agentProbes,
      chatProbes: config.chatProbes,
      agentCliVersions: {
        claudeCode: 'fake-claude 1.0.0',
        codex: 'fake-codex 1.0.0',
        cursor: 'fake-cursor 1.0.0',
      },
      runId: 'golden-run',
      probeStore: store,
      analysisStore: null,
      agentRuntime: await host.runtime({
        modes: {
          'claude': 'replay claude-code-no-tools.ndjson',
          'codex': 'replay codex-no-tools.ndjson',
          'cursor-agent': 'ok',
        },
        env: { AEO_CODEX_PROBE_MODEL: 'gpt-5.6-sol' },
      }),
      trace: {
        start: (attempt) => {
          starts.push(attempt);

          return Promise.resolve({
            id: `op-${starts.length}`,
            end: () => Promise.resolve(),
          });
        },
      },
      logContext: {},
    });

    const records = (await store.list())
      .filter(
        (record): record is CapturedUnitRecord => record.status === 'captured',
      )
      .sort(
        (a, b) => surfaces.indexOf(a.surface) - surfaces.indexOf(b.surface),
      );
    const manifest = buildCaptureManifest({
      reportKey: config.reportKey,
      runId: 'golden-run',
      createdAt: '2026-11-08T12:00:00.000Z',
      config,
      chunks: [],
      records,
      surfaces,
    });

    const pinned = {
      coverage: capture.coverage,
      unitFailures: capture.unitFailures,
      starts: [...starts].sort(
        (a, b) => surfaces.indexOf(a.surface) - surfaces.indexOf(b.surface),
      ),
      captureMetadata: Object.fromEntries(
        records.map((record) => [record.surface, record.captureMetadata]),
      ),
      probeProfiles: Object.fromEntries(
        manifest.captures.map((entry) => [entry.surface, entry.probeProfile]),
      ),
      manifest,
    };

    expectGolden(pinned, golden.allSurfaces);
  });
});
