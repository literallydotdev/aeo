import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { buildNarrativeFacts } from './agents/narrative-facts';
import { bundlePaths, calculationVersion } from './bundle/contracts';
import { exportRun } from './bundle/export';
import { answerBody } from './codex-workflow/workdir';
import { parseBundleJson } from './bundle/json';
import { verifyBundle } from './bundle/verify';
import { readArchive } from './bundle/zip';
import { createSyntheticRun } from './bundle/__fixtures__/synthetic-run';
import {
  auditFileSchema,
  measuredSurfaces,
  requestedBindings,
  toAuditConfig,
} from './engine/audit-file';
import { planLocalRun } from './engine/local-run';
import { exampleAuditFile } from './engine/templates';
import {
  assembleSectionResult,
  captureSectionProbes,
  type AnalyzedRun,
  type SectionRunArgs,
} from './pipeline';
import {
  availableBindings,
  bindingOf,
  consumerProbeBindings,
  defaultProbeBindings,
  probeEstimateUsd,
  profileOf,
  bankBindingMismatches,
  reportedModelsOn,
  requestedBindingsOf,
  RunBindingsError,
} from './probes/bindings';
import { createDataForSeoProbeClient } from './probes/dataforseo';
import {
  consumerMarketProblem,
  consumerScrapeMarkets,
  dataForSeoLanguageCodes,
  dataForSeoLocationCodes,
  resolveDataForSeoLocale,
} from './probes/dataforseo-locale';
import { legacyProbeBindings } from './probes/legacy-bindings';
import type { ProbeAttemptEnd, ProbeAttemptStart } from './probes/probe-trace';
import { runProbesForPrompts } from './probes/probes';
import { aeoSnapshotSchema, aeoVisibilitySchema } from './report/core/schema';
import {
  allSurfaces,
  consumerSurfaces,
  defaultSurfaces,
  surfaceFamilyOf,
} from './report/core/surfaces';
import type { AeoSurface } from './schema';
import { MemoryProbeStore } from './stores/memory';
import type { CapturedUnitRecord } from './stores/ports';

// ============================================================================
// The consumer apps (method release spec §5), followed through the layers
// they cross: the audit file, the plan, the bindings, the adapters, the
// scoring, the facts and the bundle. They are measured only when an audit
// lists them, and scored as a family of their own.
// ============================================================================

const standard = auditFileSchema.parse(exampleAuditFile);
const withApps = auditFileSchema.parse({
  ...exampleAuditFile,
  surfaces: [...standard.surfaces, 'google_ai_mode', 'chatgpt_app'],
});

describe('surfaces - the consumer apps', () => {
  it('should come after every earlier surface and stay out of the default plan', () => {
    expect(allSurfaces).toEqual([...defaultSurfaces, ...consumerSurfaces]);
    expect(consumerSurfaces).toEqual(['chatgpt_app', 'google_ai_mode']);
    // An audit that lists no surfaces measures the defaults.
    const { surfaces: _surfaces, ...unlisted } = exampleAuditFile;

    expect(auditFileSchema.parse(unlisted).surfaces).toEqual(defaultSurfaces);
    expect(consumerSurfaces.map(surfaceFamilyOf)).toEqual([
      'consumer',
      'consumer',
    ]);
    // The API surface keeps its own family and its place in the headline.
    expect(surfaceFamilyOf('chatgpt')).toBe('chat');
  });
});

describe('audit-file - a listed consumer app', () => {
  it('should measure a consumer app only when surfaces lists it, and say so in the configuration', () => {
    expect(measuredSurfaces(withApps)).toEqual([
      ...standard.surfaces,
      'google_ai_mode',
      'chatgpt_app',
    ]);
    // In the engine's own order, whatever order the file lists them in.
    expect(toAuditConfig(withApps).surfaces.consumerApps).toEqual([
      'chatgpt_app',
      'google_ai_mode',
    ]);
    expect(toAuditConfig(standard).surfaces).not.toHaveProperty('consumerApps');
  });

  it('should plan one answer per question on each, as another measurement than the file without them', () => {
    const planned = planLocalRun(withApps);
    const questions = planned.config.sections.flatMap(
      (section) => section.prompts,
    );
    const unitsOn = (surface: AeoSurface) => {
      return planned.plan.units.filter((unit) => unit.surface === surface);
    };

    expect(unitsOn('chatgpt_app')).toHaveLength(questions.length);
    expect(unitsOn('google_ai_mode')).toHaveLength(questions.length);
    expect(unitsOn('chatgpt_app').every((unit) => unit.runIndex === 1)).toBe(
      true,
    );
    expect(planned.digests.measurement).not.toBe(
      planLocalRun(standard).digests.measurement,
    );
    expect(planned.digests.plan).not.toBe(planLocalRun(standard).digests.plan);
  });

  it('should follow the chat depth when the audit sets one', () => {
    const deeper = planLocalRun(
      auditFileSchema.parse({
        ...exampleAuditFile,
        surfaces: ['chatgpt_app'],
        chatProbes: { runsPerPrompt: 3 },
      }),
    );
    const questions = deeper.config.sections.flatMap(
      (section) => section.prompts,
    );

    expect(deeper.plan.units).toHaveLength(questions.length * 3);
  });

  it('should freeze the binding of each listed app, and none for an audit that lists none', () => {
    expect(requestedBindings(withApps)).toEqual({
      bindings: { ...defaultProbeBindings, ...consumerProbeBindings },
      // What a resume holds the run directory to.
      overridden: ['chatgpt_app', 'google_ai_mode'],
    });
    expect(requestedBindings(standard)).toEqual({
      bindings: defaultProbeBindings,
      overridden: [],
    });
    // A scrape has no model to override.
    expect(
      auditFileSchema.safeParse({
        ...exampleAuditFile,
        probes: { chatgpt_app: { model: 'openai/gpt-test-1' } },
      }).success,
    ).toBe(false);
  });
});

describe('dataforseo-locale - the markets a consumer scrape lists', () => {
  it('should pin only codes the engine maps, and every mapped location for the ChatGPT scrape', () => {
    const mappedLocations = new Set(Object.values(dataForSeoLocationCodes));
    const mappedLanguages = new Set(Object.values(dataForSeoLanguageCodes));

    for (const surface of consumerSurfaces) {
      const { locationCodes, languageCodes } = consumerScrapeMarkets[surface];

      expect(
        [...languageCodes].filter((code) => !mappedLanguages.has(code)),
      ).toEqual([]);
      expect(
        [...(locationCodes ?? [])].filter((code) => !mappedLocations.has(code)),
      ).toEqual([]);
    }

    expect(consumerScrapeMarkets.chatgpt_app.locationCodes).toEqual(
      mappedLocations,
    );
    // The vendor publishes no list of where Google serves AI Mode.
    expect(consumerScrapeMarkets.google_ai_mode.locationCodes).toBeNull();
  });

  it('should name the half of a market a scrape does not list, and nothing for a market it lists or one no table maps', () => {
    const aiModeInPortuguese =
      'google_ai_mode cannot be measured in language "pt": of the languages an audit can name, DataForSEO lists en, es, fr, de, pt-BR, ja, zh-CN, zh-TW, ko, it, nl for that app (read on 2026-11-11).';

    expect(consumerMarketProblem('chatgpt_app', 'US', 'English')).toBe(
      undefined,
    );
    expect(consumerMarketProblem('chatgpt_app', 'br', 'pt')).toBe(undefined);
    expect(consumerMarketProblem('google_ai_mode', 'br', 'pt')).toBe(
      aiModeInPortuguese,
    );
    expect(consumerMarketProblem('google_ai_mode', 'br', 'pt-PT')).toContain(
      'in language "pt-PT"',
    );
    expect(consumerMarketProblem('google_ai_mode', 'br', 'pt-br')).toBe(
      undefined,
    );
    expect(consumerMarketProblem('google_ai_mode', 'us', 'zh-CN')).toBe(
      undefined,
    );
    // Refused for every placed surface, by the rule that maps markets.
    expect(consumerMarketProblem('chatgpt_app', 'global', 'en')).toBe(
      undefined,
    );
    expect(consumerMarketProblem('chatgpt_app', 'us', 'zh')).toBe(undefined);
  });

  it('should refuse an audit file that lists a consumer app in a market its scrape does not list, at the app', () => {
    const inPortuguese = (language: string, surfaces: string[]) => {
      return auditFileSchema.safeParse({
        ...exampleAuditFile,
        geography: 'br',
        language,
        surfaces,
      });
    };

    const refused = inPortuguese('pt', [
      'chatgpt',
      'chatgpt_app',
      'google_ai_mode',
    ]);

    expect(refused.error?.issues).toMatchObject([
      {
        path: ['surfaces', 2],
        message:
          'google_ai_mode cannot be measured in language "pt": of the languages an audit can name, DataForSEO lists en, es, fr, de, pt-BR, ja, zh-CN, zh-TW, ko, it, nl for that app (read on 2026-11-11). Please leave it out of surfaces.',
      },
    ]);
    expect(inPortuguese('pt', ['chatgpt', 'chatgpt_app']).success).toBe(true);
    expect(
      inPortuguese('pt-BR', ['chatgpt', 'chatgpt_app', 'google_ai_mode'])
        .success,
    ).toBe(true);
  });
});

describe('audit-file - the market an audit names', () => {
  it('should measure the United States in English unless the file says otherwise, and show both in the example', () => {
    const {
      geography: _geography,
      language: _language,
      ...unstated
    } = exampleAuditFile;

    expect(auditFileSchema.parse(unstated)).toMatchObject({
      geography: 'us',
      language: 'en',
    });
    expect(exampleAuditFile).toMatchObject({ geography: 'us', language: 'en' });
  });

  it('should take Chinese by its script and Portuguese by its region, as DataForSEO spells them', () => {
    expect(resolveDataForSeoLocale('us', 'zh-CN')).toEqual({
      locationCode: 2840,
      languageCode: 'zh-CN',
    });
    expect(resolveDataForSeoLocale('US', 'ZH-tw')?.languageCode).toBe('zh-TW');
    expect(resolveDataForSeoLocale('br', 'pt-br')?.languageCode).toBe('pt-BR');
    expect(resolveDataForSeoLocale('br', 'pt')?.languageCode).toBe('pt');
  });

  it('should refuse a plain Chinese, which Google lists only by its two scripts, naming the codes an audit can use', () => {
    const plain = auditFileSchema.safeParse({
      ...exampleAuditFile,
      language: 'zh',
    });

    expect(resolveDataForSeoLocale('us', 'zh')).toBeUndefined();
    expect(resolveDataForSeoLocale('us', 'Chinese')).toBeUndefined();
    expect(plain.error?.issues).toMatchObject([
      {
        path: ['geography'],
        message:
          'No search market for geography "us" and language "zh". Supported geographies: us, gb, ca, au, de, fr, es, it, nl, br, in, jp, se, no, dk. Supported languages: en, es, fr, de, pt, pt-BR, pt-PT, ja, zh-CN, zh-TW, ko, it, nl.',
      },
    ]);
    expect(
      auditFileSchema.safeParse({ ...exampleAuditFile, language: 'zh-CN' })
        .success,
    ).toBe(true);
  });
});

// The bindings of a run whose audit lists both apps.
const appBindings = requestedBindingsOf({}, [], consumerSurfaces);

describe('bindings - the consumer apps', () => {
  it('should reserve a probe at the price the scrapes reported, with room for one billed retry, and need the DataForSEO login', () => {
    for (const surface of consumerSurfaces) {
      const binding = bindingOf(appBindings, surface);

      expect(probeEstimateUsd(binding, new Map())).toEqual({
        low: 0.004,
        high: 0.008,
      });
      expect(profileOf(binding).settings.map(({ name }) => name)).toEqual([
        'DATAFORSEO_LOGIN',
        'DATAFORSEO_PASSWORD',
      ]);
      expect(profileOf(binding).billing).toBe('metered');
    }
  });

  it('should keep the bindings of a run directory that started without a consumer app, and refuse to measure one in it', () => {
    for (const frozen of [legacyProbeBindings, defaultProbeBindings]) {
      const bindings = availableBindings(frozen);

      expect(bindings).toEqual(frozen);
      expect(() => bindingOf(bindings, 'chatgpt_app')).toThrow(
        RunBindingsError,
      );
      expect(() => bindingOf(bindings, 'chatgpt_app')).toThrow(
        /the run directory started without it/,
      );
    }

    expect(availableBindings(appBindings)).toEqual(appBindings);
  });

  it('should refuse a frozen consumer binding that names a model or another adapter', () => {
    expect(() =>
      availableBindings({
        ...appBindings,
        chatgpt_app: { adapter: 'gateway.openai@1', model: 'openai/gpt-x' },
      }),
    ).toThrow(/measures chatgpt_app with gateway\.openai@1/);
    expect(() =>
      availableBindings({
        ...appBindings,
        google_ai_mode: { adapter: 'dataforseo.chatgpt_app@1' },
      }),
    ).toThrow(/measures google_ai_mode with dataforseo\.chatgpt_app@1/);
  });
});

const fixture = (name: string): unknown => {
  return JSON.parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        'probes',
        '__fixtures__',
        'dataforseo',
        `${name}.json`,
      ),
      'utf8',
    ),
  );
};

describe('probes - runProbesForPrompts() on the consumer apps', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should bank one answer per question from each scrape, with the cost each response reported and the model the scraper named', async () => {
    // Each scrape answers with its own captured response.
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((url) =>
        Promise.resolve(
          Response.json(
            fixture(
              typeof url === 'string' && url.includes('ai_mode')
                ? 'ai-mode'
                : 'chatgpt-app',
            ),
          ),
        ),
      );

    vi.stubGlobal('fetch', fetch);

    const started: ProbeAttemptStart[] = [];
    const ended: ProbeAttemptEnd[] = [];
    const outcomes = await runProbesForPrompts({
      geography: 'us',
      language: 'en',
      prompts: [
        {
          id: 'p1',
          promptText: 'What is the current LTS version of Node.js?',
          category: 'general_knowledge',
        },
      ],
      // Named out of order: the batch asks in the engine's own order.
      surfaces: ['google_ai_mode', 'chatgpt_app'],
      chatProbes: undefined,
      trace: {
        start: (attempt) => {
          started.push(attempt);

          return Promise.resolve({
            id: `op-${started.length}`,
            end: (result) => {
              ended.push(result);

              return Promise.resolve();
            },
          });
        },
      },
      dependencies: {
        bindings: appBindings,
        gateway: () => {
          throw new Error('A scrape asks no gateway model.');
        },
        dataForSeo: createDataForSeoProbeClient({
          login: 'test-login',
          password: 'test-password',
        }),
      },
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      outcomes.map((outcome) => [outcome.status, outcome.unit.surface]),
    ).toEqual([
      ['captured', 'chatgpt_app'],
      ['captured', 'google_ai_mode'],
    ]);
    expect(
      started.map(({ adapter, requestedModel }) => [adapter, requestedModel]),
    ).toEqual([
      ['dataforseo.chatgpt_app@1', null],
      ['dataforseo.ai_mode@1', null],
    ]);
    expect(ended).toEqual([
      expect.objectContaining({ outcome: 'succeeded', costUsd: 0.004 }),
      expect.objectContaining({ outcome: 'succeeded', costUsd: 0.004 }),
    ]);

    const [chatGpt, aiMode] = outcomes;

    assert(chatGpt?.status === 'captured' && aiMode?.status === 'captured');
    // As the scraper reported it: there is no requested model to compare
    // it with.
    expect(chatGpt.probe.reportedModel).toBe('gpt-6');
    expect(chatGpt.probe.retrieval).toMatchObject({ exposure: 'partial' });
    expect(chatGpt.probe.text).toContain(
      'Sources used by search:\n- Official Node.js download page: https://nodejs.org/en/download',
    );
    expect(aiMode.probe).not.toHaveProperty('reportedModel');
    expect(aiMode.probe).not.toHaveProperty('noOverview');
    expect(aiMode.probe.retrieval).toEqual({ exposure: 'none', calls: [] });
    // The same block as every chat surface: the work directory keeps it
    // apart from the body the answer is judged on.
    expect(aiMode.probe.text).toContain(
      'Sources used by search:\n- Node.js — Node.js 26.13.0 (LTS): https://nodejs.org/en/blog/release/v26.13.0',
    );
    expect(answerBody(aiMode.probe.text)).not.toContain('Sources used');
    expect(answerBody(chatGpt.probe.text)).not.toContain('Sources used');
  });

  it('should keep an AI Mode scrape that came back without its answer as a failed unit, retried once, never a captured answer', async () => {
    vi.useFakeTimers();

    const noResults = structuredClone(fixture('ai-mode-failed')) as {
      tasks: { status_code: number; status_message: string }[];
    };
    const [task] = noResults.tasks;

    assert(task);
    // No request returned 40102 on 11 November 2026; this is the captured
    // failure with the documented code.
    task.status_code = 40102;
    task.status_message = 'No Search Results.';

    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(Response.json(noResults)));

    vi.stubGlobal('fetch', fetch);

    try {
      const run = runProbesForPrompts({
        geography: 'us',
        language: 'en',
        prompts: [{ id: 'p1', promptText: 'Which store?', category: 'x' }],
        surfaces: ['google_ai_mode'],
        chatProbes: undefined,
        dependencies: {
          bindings: appBindings,
          gateway: () => {
            throw new Error('A scrape asks no gateway model.');
          },
          dataForSeo: createDataForSeoProbeClient({
            login: 'test-login',
            password: 'test-password',
          }),
        },
      });

      await vi.runAllTimersAsync();

      expect(await run).toEqual([
        {
          status: 'failed',
          unit: { promptId: 'p1', surface: 'google_ai_mode', runIndex: 1 },
          kind: 'empty_answer',
          attempts: 2,
          lastError: 'DataForSEO task 40102: No Search Results.',
        },
      ]);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pipeline - captureSectionProbes() on the consumer apps', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should bank each answer with its adapter, no requested model and the model the scraper named, and reuse the bank on a resume', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((url) =>
        Promise.resolve(
          Response.json(
            fixture(
              typeof url === 'string' && url.includes('ai_mode')
                ? 'ai-mode'
                : 'chatgpt-app',
            ),
          ),
        ),
      );

    vi.stubGlobal('fetch', fetch);

    const probeStore = new MemoryProbeStore();
    const args: SectionRunArgs = {
      sectionKey: 'main',
      brand: { name: 'Acme Files', domain: 'acme.example', aliases: [] },
      competitors: [
        { name: 'Rival Files', domain: 'rival.example', aliases: [] },
      ],
      prompts: [
        {
          id: 'p1',
          text: 'What is the current LTS version of Node.js?',
          category: 'general_knowledge',
        },
      ],
      geography: 'us',
      language: 'en',
      surfaces: ['chatgpt_app', 'google_ai_mode'],
      agentProbes: { runsPerPrompt: 2 },
      chatProbes: undefined,
      agentCliVersions: { claudeCode: null, codex: null, cursor: null },
      runId: 'RUN1',
      probeStore,
      analysisStore: null,
      probeDependencies: {
        bindings: appBindings,
        gateway: () => {
          throw new Error('A scrape asks no gateway model.');
        },
        dataForSeo: createDataForSeoProbeClient({
          login: 'test-login',
          password: 'test-password',
        }),
      },
      logContext: {},
    };

    const first = await captureSectionProbes(args);
    const banked = (await probeStore.list()).filter(
      (record) => record.status === 'captured',
    );
    const parameters = {
      geography: 'us',
      language: 'en',
      agentProbes: { runsPerPrompt: 2 },
    };

    expect(first.coverage).toEqual([
      { surface: 'chatgpt_app', planned: 1, captured: 1 },
      { surface: 'google_ai_mode', planned: 1, captured: 1 },
    ]);
    // A consumer app has no legacy adapter: its capture always names the
    // one that took it.
    expect(
      Object.fromEntries(
        banked.map((record) => [record.surface, record.captureMetadata]),
      ),
    ).toEqual({
      chatgpt_app: {
        requestedModel: null,
        reportedModel: 'gpt-6',
        parameters,
        adapter: 'dataforseo.chatgpt_app@1',
      },
      google_ai_mode: {
        requestedModel: null,
        reportedModel: null,
        parameters,
        adapter: 'dataforseo.ai_mode@1',
      },
    });
    expect(bankBindingMismatches(banked, appBindings)).toEqual([]);

    // A resume probes nothing again: both answers are in the bank.
    const resumed = await captureSectionProbes(args);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(resumed.probes.map((probe) => probe.text)).toEqual(
      first.probes.map((probe) => probe.text),
    );
  });
});

describe('bindings - reportedModelsOn()', () => {
  it("should list the models a consumer app's captured answers were reported as, once each", () => {
    const captured = (
      surface: AeoSurface,
      runIndex: number,
      reportedModel: string | null,
    ): CapturedUnitRecord => {
      return {
        status: 'captured',
        sectionKey: 'file_stores',
        promptId: 'p1',
        promptText: 'Which store?',
        surface,
        runIndex,
        capturedAt: '2026-11-11T10:00:00.000Z',
        probe: {
          promptId: 'p1',
          promptText: 'Which store?',
          promptCategory: 'comparison',
          modelName: surface,
          runIndex,
          text: 'Acme Files.',
        },
        captureMetadata: {
          requestedModel: null,
          reportedModel,
          parameters: {},
          adapter: 'dataforseo.chatgpt_app@1',
        },
      };
    };
    const records = [
      captured('chatgpt_app', 1, 'gpt-6'),
      captured('chatgpt_app', 2, 'gpt-6'),
      captured('chatgpt_app', 3, 'gpt-5-5'),
      captured('chatgpt_app', 4, null),
      captured('google_ai_mode', 1, null),
    ];

    expect(reportedModelsOn(records, 'chatgpt_app')).toEqual([
      'gpt-5-5',
      'gpt-6',
    ]);
    expect(reportedModelsOn(records, 'google_ai_mode')).toEqual([]);
  });
});

const prompts = [
  { id: 'p1', text: 'Best tools?', category: 'comparison' as const },
  { id: 'p2', text: 'Who leads?', category: 'industry_expert' as const },
];

const judged = (
  promptIdx: number,
  surface: AeoSurface,
  mentioned: boolean,
): AnalyzedRun => {
  return {
    promptIdx,
    promptId: prompts[promptIdx]?.id ?? '',
    surface,
    runIndex: 1,
    clientMentioned: mentioned,
    clientCited: false,
    clientPosition: mentioned ? 'primary' : 'absent',
    clientSentiment: 'neutral',
    contextSnippet: null,
    responseText: `answer ${promptIdx} ${surface}`,
    citedUrls: [],
    competitorMentions: [
      { domain: 'rival.example', mentioned: !mentioned, cited: false },
    ],
    allMentionedBrands: [],
  };
};

const assembled = (surfaces: AeoSurface[], runs: AnalyzedRun[]) => {
  return assembleSectionResult(
    {
      sectionKey: 'main',
      brand: { name: 'Acme Files', domain: 'acme.example', aliases: [] },
      competitors: [
        { name: 'Rival Files', domain: 'rival.example', aliases: [] },
      ],
      prompts,
      surfaces,
      agentProbes: { runsPerPrompt: 2 },
      // One run per question on every surface asked through an API.
      chatProbes: { runsPerPrompt: 1 },
      calculationVersion,
    },
    {
      probeCount: runs.length,
      coverage: [],
      lostPromptIds: [],
      unitFailures: [],
      rejectedWebToolSurfaces: [],
      freshChatRetrieval: [],
      freshAgentRetrieval: [],
    },
    prompts.map((prompt, promptIdx) => ({
      promptId: prompt.id,
      runs: runs.filter((run) => run.promptIdx === promptIdx),
      cached: false,
      error: null,
    })),
  ).visibility;
};

describe('pipeline - assembleSectionResult() with consumer apps', () => {
  const chatRuns = [judged(0, 'chatgpt', false), judged(1, 'chatgpt', true)];
  const appRuns = [
    judged(0, 'chatgpt_app', true),
    judged(1, 'chatgpt_app', true),
    judged(0, 'google_ai_mode', true),
    // The second AI Mode answer was planned and never captured.
  ];

  it('should score the consumer apps as a pair of their own and never change the chat pair', () => {
    const both = assembled(
      ['chatgpt', 'chatgpt_app', 'google_ai_mode'],
      [...chatRuns, ...appRuns],
    );
    const chatOnly = assembled(['chatgpt'], chatRuns);

    expect(both.summary.prospectShareOfVoice).toBe(0.5);
    expect(both.summary.prospectShareOfVoice).toBe(
      chatOnly.summary.prospectShareOfVoice,
    );
    expect(both.summary.prospectShareOfVoiceEvidence).toEqual(
      chatOnly.summary.prospectShareOfVoiceEvidence,
    );
    // Three of the four planned consumer answers mention the brand: the
    // missing one counts against it.
    expect(both.summary.consumerShareOfVoice).toBe(0.75);
    expect(both.summary.consumerCitationRate).toBe(0);
    expect(both.summary.consumerShareOfVoiceEvidence).toMatchObject({
      count: 3,
      captured: 3,
      planned: 4,
    });
    expect(both.summary.byModel.google_ai_mode).toMatchObject({
      shareOfVoice: 0.5,
      shareOfVoiceEvidence: { count: 1, captured: 1, planned: 2 },
    });
    expect(both.surfaces).toEqual(['chatgpt', 'chatgpt_app', 'google_ai_mode']);
    // The competitor split still comes from the chat surfaces.
    expect(both.summary.byCompetitor).toEqual(chatOnly.summary.byCompetitor);
  });

  it('should leave the consumer pair out of a summary that planned no consumer app', () => {
    const chatOnly = assembled(['chatgpt'], chatRuns);

    expect(chatOnly.summary).not.toHaveProperty('consumerShareOfVoice');
    expect(chatOnly.summary).not.toHaveProperty('consumerCitationRate');
    expect(chatOnly.summary).not.toHaveProperty('consumerShareOfVoiceEvidence');
  });

  it('should give a run that measured only consumer apps no chat headline, and its competitor split from them', () => {
    const appsOnly = assembled(['chatgpt_app', 'google_ai_mode'], appRuns);

    expect(appsOnly.summary.prospectShareOfVoice).toBeNull();
    expect(appsOnly.summary.prospectCitationRate).toBeNull();
    expect(appsOnly.summary.agentShareOfVoice).toBeNull();
    expect(appsOnly.summary.consumerShareOfVoice).toBe(0.75);
    expect(appsOnly.summary.byCompetitor).toEqual([
      expect.objectContaining({ domain: 'rival.example', capturedAnswers: 3 }),
    ]);
  });
});

describe('a run with consumer apps', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aeo-consumer-surface-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const exported = async (
    name: string,
    consumerApps: readonly (typeof consumerSurfaces)[number][],
  ) => {
    const run = await createSyntheticRun(path.join(root, name), {
      consumerApps,
    });

    return readArchive(await readFile((await exportRun(run.dir)).archive));
  };

  const summariesOf = (files: ReadonlyMap<string, Buffer>) => {
    return z
      .looseObject({
        sections: z.array(z.looseObject({ visibility: aeoVisibilitySchema })),
      })
      .parse(
        parseBundleJson(
          (files.get(bundlePaths.snapshot) ?? Buffer.alloc(0)).toString('utf8'),
        ),
      )
      .sections.map((section) => section.visibility);
  };

  it('should export and verify, with the consumer pair recomputed and the chat pair planned as without them', async () => {
    const files = await exported('apps', ['chatgpt_app', 'google_ai_mode']);
    const [first] = summariesOf(files);
    const [reference] = summariesOf(await exported('standard', []));
    const verification = verifyBundle(files, 'apps');
    const outcome = (id: string) => {
      return verification.checks.find((check) => check.id === id)?.outcome;
    };

    assert(first && reference);
    expect(first.surfaces).toEqual([
      'chatgpt',
      'perplexity',
      'chatgpt_app',
      'google_ai_mode',
    ]);
    // Two questions, once each on two apps.
    expect(first.summary.consumerShareOfVoiceEvidence?.planned).toBe(4);
    expect(first.summary.prospectShareOfVoiceEvidence?.planned).toBe(
      reference.summary.prospectShareOfVoiceEvidence?.planned,
    );
    expect(reference.summary).not.toHaveProperty('consumerShareOfVoice');
    expect(outcome('bundle.integrity')).toBe('pass');
    expect(outcome('plan.accounted')).toBe('pass');
    expect(outcome('judgments.evidence')).toBe('pass');
    expect(outcome('metrics.recomputed')).toBe('pass');
  });
});

describe('narrative-facts - buildNarrativeFacts() with consumer apps', () => {
  const config = toAuditConfig(withApps);
  const [section] = config.sections;
  const [prompt] = section?.prompts ?? [];

  const snapshotWith = (surfaces: readonly string[]) => {
    assert(section && prompt);

    return aeoSnapshotSchema.parse({
      version: 2,
      reportKey: config.reportKey,
      brand: config.brand,
      competitors: config.competitors,
      sections: [
        {
          key: section.key,
          visibility: {
            prompts: [{ text: prompt.text, category: prompt.category }],
            surfaces,
            matrix: surfaces.map((surface) => ({
              promptIdx: 0,
              surface,
              runIndex: 1,
              prospectMentioned: true,
              prospectPosition: 'absent',
              contextSnippet: null,
              citedUrls: [],
              competitors: [],
            })),
            summary: {
              prospectShareOfVoice: null,
              prospectCitationRate: null,
              agentShareOfVoice: null,
              agentCitationRate: null,
              byModel: {},
              byCompetitor: [],
              topCompetitorDomain: null,
            },
          },
        },
      ],
      meta: {
        generatedAt: '2026-11-11T00:00:00.000Z',
        promptCount: 1,
        probeCount: surfaces.length,
        partialFailures: [],
      },
    });
  };
  const factsOf = (surfaces: readonly string[]) => {
    const facts = buildNarrativeFacts(snapshotWith(surfaces), config, 'run-1');

    return {
      scope: facts.find(({ factId }) => factId === 'scope:surfaces')?.sentence,
      byId: new Map(facts.map((fact) => [fact.factId, fact])),
    };
  };

  it('should name a captured consumer app beside the API surface of the same product, and only then', () => {
    assert(section);

    const withApp = factsOf(['chatgpt', 'chatgpt_app', 'google_ai_mode']);
    const without = factsOf(['chatgpt']);

    expect(withApp.scope).toContain(
      'Captured chat and search assistants: ChatGPT (API). Captured coding agents: none. Captured consumer apps: ChatGPT (app), AI Mode.',
    );
    expect(without.scope).toContain(
      'Captured chat and search assistants: ChatGPT (API). Captured coding agents: none. Planned',
    );
    expect(
      withApp.byId.get(`market:${section.key}:consumer:brand:mentions`),
    ).toMatchObject({
      numerator: 2,
      // One planned answer on each app for the section's questions.
      denominator: section.prompts.length * 2,
    });
    expect(
      withApp.byId.get(`market:${section.key}:consumer:brand:mentions`)
        ?.sentence,
    ).toContain('consumer apps mentioned');
    expect([...without.byId.keys()]).toEqual(
      [...withApp.byId.keys()].filter((id) => !id.includes(':consumer:')),
    );
  });
});
