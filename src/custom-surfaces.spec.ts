import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildNarrativeFacts } from './agents/narrative-facts';
import { bundlePaths } from './bundle/contracts';
import { exportRun } from './bundle/export';
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
  createChatAdapter,
  defaultProbeBindings,
  probeEstimateUsd,
  requestedBindingsOf,
  surfaceLabelOverrides,
} from './probes/bindings';
import { extractGatewaySearchRetrieval } from './probes/chat-retrieval';
import { checkRetrievalCapture } from './probes/web-tool-guard';
import { aeoSnapshotSchema, aeoVisibilitySchema } from './report/core/schema';
import { surfaceFamilyOf } from './report/core/surfaces';
import { planRun, RunRequestError } from './runner';
import { runRequestSchema } from './schema';
import type { CapturedUnitRecord } from './stores/ports';

// ============================================================================
// Any gateway model as a surface of its own (open models spec §5), followed
// through the layers it crosses: the audit file, the plan, the bindings, the
// adapter, the scoring, the facts and the bundle.
// ============================================================================

const grok = { key: 'grok', label: 'Grok 5', model: 'acme/grok-5' };
const withGrok = auditFileSchema.parse({
  ...exampleAuditFile,
  customSurfaces: [grok],
});
const standard = auditFileSchema.parse(exampleAuditFile);

describe('audit-file - customSurfaces', () => {
  it('should measure every declared custom surface, and bind its model to the gateway search adapter', () => {
    expect(measuredSurfaces(withGrok)).toEqual([
      ...standard.surfaces,
      'custom:grok',
    ]);
    expect(requestedBindings(withGrok)).toEqual({
      bindings: {
        ...defaultProbeBindings,
        'custom:grok': { adapter: 'gateway.search@1', model: 'acme/grok-5' },
      },
      overridden: ['custom:grok'],
    });
  });

  it('should keep the model out of the configuration, so swapping it never changes what is measured', () => {
    const repointed = auditFileSchema.parse({
      ...exampleAuditFile,
      customSurfaces: [{ ...grok, model: 'acme/grok-6' }],
    });

    expect(toAuditConfig(withGrok).customSurfaces).toEqual([
      { key: 'grok', label: 'Grok 5' },
    ]);
    expect(planLocalRun(repointed).digests).toEqual(
      planLocalRun(withGrok).digests,
    );
    // Declaring the surface at all is another measurement.
    expect(planLocalRun(withGrok).digests.measurement).not.toBe(
      planLocalRun(standard).digests.measurement,
    );
    expect(toAuditConfig(standard)).not.toHaveProperty('customSurfaces');
  });

  it('should refuse a duplicate key, a malformed key and a surface it does not declare', () => {
    const parse = (fields: Record<string, unknown>) => {
      return auditFileSchema.safeParse({ ...exampleAuditFile, ...fields });
    };

    expect(parse({ customSurfaces: [grok, grok] }).success).toBe(false);
    expect(
      parse({ customSurfaces: [{ ...grok, key: 'Grok 5' }] }).success,
    ).toBe(false);
    expect(parse({ surfaces: ['chatgpt', 'custom:grok'] }).success).toBe(false);
    expect(
      parse({ surfaces: ['custom:grok'], customSurfaces: [grok] }).success,
    ).toBe(true);
  });
});

describe('runner - planRun() with a custom surface', () => {
  const config = toAuditConfig(withGrok);
  const request = (surfaces: string[]) => {
    return runRequestSchema.parse({
      reportKey: config.reportKey,
      runId: 'run-1',
      surfaces,
    });
  };

  it('should ask a custom surface every question at the chat depth', () => {
    const plan = planRun(config, request(['custom:grok']));
    const questions = config.sections.flatMap((section) => section.prompts);

    expect(plan.units).toHaveLength(questions.length * 2);
    expect(new Set(plan.units.map((unit) => unit.surface))).toEqual(
      new Set(['custom:grok']),
    );
  });

  it('should refuse a custom surface the config does not declare', () => {
    expect(() => planRun(config, request(['custom:other']))).toThrow(
      RunRequestError,
    );
    expect(() => planRun(config, request(['custom:other']))).toThrow(
      /custom:other, which the config's customSurfaces does not declare/,
    );
  });
});

describe('bindings - a custom surface', () => {
  const bindings = requestedBindingsOf({}, [grok]);

  it("should ask its model with the gateway's search tool, in the audit's market", () => {
    const adapter = createChatAdapter('custom:grok', {
      geography: 'no',
      language: 'nb',
      dependencies: {
        bindings,
        gateway: () => {
          throw new Error('No gateway here.');
        },
      },
    });

    expect(adapter).toMatchObject({
      id: 'gateway.search@1',
      surface: 'custom:grok',
      model: 'acme/grok-5',
      billing: 'metered',
      observes: { retrieval: 'full', servedModel: 'compare_to_requested' },
    });
    expect(adapter.request('Which store?')).toMatchObject({
      parameters: {
        model: 'acme/grok-5',
        // Any model may reason: room to finish, from the adapter's first
        // release.
        maxOutputTokens: 16_000,
        toolChoice: 'required',
        tools: [
          {
            name: 'perplexity_search',
            id: 'gateway.perplexity_search',
            args: { country: 'NO', searchLanguageFilter: ['nb'] },
          },
        ],
      },
    });
  });

  it('should search a regional variant by its language, and leave out a language that is no code', () => {
    const toolArgsIn = (language: string) => {
      const adapter = createChatAdapter('custom:grok', {
        geography: 'br',
        language,
        dependencies: {
          bindings,
          gateway: () => {
            throw new Error('No gateway here.');
          },
        },
      });

      return adapter.request('Which store?');
    };

    expect(toolArgsIn('pt-BR')).toMatchObject({
      parameters: {
        tools: [{ args: { country: 'BR', searchLanguageFilter: ['pt'] } }],
      },
    });
    expect(toolArgsIn('zh-CN')).toMatchObject({
      parameters: {
        tools: [{ args: { country: 'BR', searchLanguageFilter: ['zh'] } }],
      },
    });
    expect(toolArgsIn('portuguese')).toMatchObject({
      parameters: { tools: [{ args: { country: 'BR' } }] },
    });
    expect(JSON.stringify(toolArgsIn('portuguese'))).not.toContain(
      'searchLanguageFilter',
    );
  });

  it("should price a probe at the model's catalog price and the gateway's own search fee", () => {
    const binding = bindings['custom:grok'];

    assert(binding);

    const estimate = probeEstimateUsd(
      binding,
      new Map([
        [
          'acme/grok-5',
          {
            id: 'acme/grok-5',
            label: 'Grok 5',
            pricingUsdPerMillion: { input: 2, output: 10, cachedInput: 0.2 },
            // The model's own search fee is not what this adapter pays.
            webSearchUsdPerRequest: 0.5,
            contextWindow: null,
            maxOutputTokens: null,
            reasoning: false,
            reasoningEfforts: [],
          },
        ],
      ]),
    );

    // 8,000 tokens in, 500 out and one $0.005 search; 75,000 in, 8,000
    // out and ten.
    expect(estimate.low).toBeCloseTo(0.016 + 0.005 + 0.005, 10);
    expect(estimate.high).toBeCloseTo(0.15 + 0.08 + 0.05, 10);
  });

  it('should always carry its own label, with the model its answers were asked of', () => {
    const asked: CapturedUnitRecord = {
      status: 'captured',
      sectionKey: 'file_stores',
      promptId: 'p1',
      promptText: 'Which store?',
      surface: 'custom:grok',
      runIndex: 1,
      capturedAt: '2026-11-10T10:00:00.000Z',
      probe: {
        promptId: 'p1',
        promptText: 'Which store?',
        promptCategory: 'comparison',
        modelName: 'custom:grok',
        runIndex: 1,
        text: 'Acme Files.',
      },
      captureMetadata: {
        requestedModel: 'acme/grok-5',
        reportedModel: null,
        parameters: {},
        adapter: 'gateway.search@1',
      },
    };

    expect(surfaceLabelOverrides([asked], [grok])).toEqual({
      'custom:grok': 'Grok 5 (acme/grok-5)',
    });
    // Nothing captured: the model it was asked of is not known here.
    expect(surfaceLabelOverrides([], [grok])).toEqual({
      'custom:grok': 'Grok 5',
    });
  });
});

describe('chat-retrieval - extractGatewaySearchRetrieval()', () => {
  // The shapes the captured answer did not exercise (a list of queries, an
  // error object), as the pinned SDK declares them (PerplexitySearchInput
  // and PerplexitySearchResponse). chat-retrieval.spec.ts reads the capture.
  const call = (toolCallId: string, query: unknown) => {
    return {
      type: 'tool-call',
      toolName: 'perplexity_search',
      toolCallId,
      input: { query },
    };
  };
  const result = (toolCallId: string, output: unknown) => {
    return {
      type: 'tool-result',
      toolName: 'perplexity_search',
      toolCallId,
      output,
    };
  };

  it("should record each search with every result the tool returned, and an error's results as not known", () => {
    const log = extractGatewaySearchRetrieval([
      {
        content: [
          call('c1', 'best file stores'),
          result('c1', {
            id: 'search-1',
            results: [
              { title: 'A', url: 'https://acme.example/a', snippet: '' },
              { title: 'B', url: 'https://rival.example/b', snippet: '' },
            ],
          }),
          call('c2', ['acme files review', 'rival files review']),
          result('c2', { error: 'rate_limit', message: 'Slow down.' }),
          { type: 'text', text: 'Acme Files.' },
        ],
      },
    ]);

    expect(log).toEqual({
      exposure: 'full',
      calls: [
        {
          kind: 'search',
          query: 'best file stores',
          url: null,
          resultUrls: ['https://acme.example/a', 'https://rival.example/b'],
          resultsComplete: true,
        },
        {
          kind: 'search',
          query: 'acme files review',
          url: null,
          resultUrls: null,
          resultsComplete: true,
        },
        {
          kind: 'search',
          query: 'rival files review',
          url: null,
          resultUrls: null,
          resultsComplete: true,
        },
      ],
    });
  });

  it('should find no calls in a stream of another shape, never invent one', () => {
    expect(
      extractGatewaySearchRetrieval([
        { content: [{ type: 'tool-call', toolName: 'web_search', input: {} }] },
      ]).calls,
    ).toEqual([]);
  });
});

describe('web-tool-guard - checkRetrievalCapture() with a custom surface', () => {
  it('should report a custom surface whose captured answers carry no retrieval log', () => {
    const rows = Array.from({ length: 12 }, () => ({
      surface: 'custom:grok',
      retrievalCalls: null,
    }));

    expect(checkRetrievalCapture(rows).map((failure) => failure.step)).toEqual([
      'probes:retrieval_capture:custom:grok',
    ]);
  });
});

describe('a run with a custom surface', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aeo-custom-surface-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

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

  const exported = async (name: string, customSurface?: typeof grok) => {
    const run = await createSyntheticRun(path.join(root, name), {
      ...(customSurface && {
        customSurface: { key: customSurface.key, label: customSurface.label },
      }),
    });

    return readArchive(await readFile((await exportRun(run.dir)).archive));
  };

  it('should score the custom surface on its own line and leave the headline to the chat surfaces', async () => {
    const files = await exported('custom', grok);
    const [first] = summariesOf(files);
    const [reference] = summariesOf(await exported('standard'));

    assert(first && reference);
    expect(first.surfaces).toEqual(['chatgpt', 'perplexity', 'custom:grok']);
    expect(Object.keys(first.summary.byModel)).toEqual([
      'chatgpt',
      'perplexity',
      'custom:grok',
    ]);
    expect(first.summary.byModel['custom:grok']?.shareOfVoiceEvidence).toEqual(
      expect.objectContaining({ planned: 4 }),
    );
    // The headline is planned over the two chat surfaces only, as without
    // the custom one.
    expect(first.summary.prospectShareOfVoiceEvidence?.planned).toBe(
      reference.summary.prospectShareOfVoiceEvidence?.planned,
    );
  });

  it('should export and verify, with the surface in the plan and its judgments recomputed', async () => {
    const verification = verifyBundle(await exported('custom', grok), 'custom');
    const outcome = (id: string) => {
      return verification.checks.find((check) => check.id === id)?.outcome;
    };

    expect(outcome('bundle.integrity')).toBe('pass');
    expect(outcome('plan.accounted')).toBe('pass');
    expect(outcome('judgments.evidence')).toBe('pass');
    expect(outcome('metrics.recomputed')).toBe('pass');
  });

  it('should name a captured custom model in the facts, and only then', () => {
    const config = toAuditConfig(withGrok);
    const [section] = config.sections;
    const [prompt] = section?.prompts ?? [];

    assert(section && prompt);

    const snapshotWith = (surface: string) => {
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
              surfaces: [surface],
              matrix: [
                {
                  promptIdx: 0,
                  surface,
                  runIndex: 1,
                  prospectMentioned: true,
                  prospectPosition: 'absent',
                  contextSnippet: null,
                  citedUrls: [],
                  competitors: [],
                },
              ],
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
          generatedAt: '2026-11-10T00:00:00.000Z',
          promptCount: 1,
          probeCount: 1,
          partialFailures: [],
          surfaceLabels: { 'custom:grok': 'Grok 5 (acme/grok-5)' },
        },
      });
    };
    const scopeOf = (surface: string) => {
      const facts = buildNarrativeFacts(snapshotWith(surface), config, 'run-1');

      return {
        scope: facts.find(({ factId }) => factId === 'scope:surfaces')
          ?.sentence,
        ids: facts.map(({ factId }) => factId),
      };
    };

    const custom = scopeOf('custom:grok');
    const chat = scopeOf('chatgpt');

    expect(custom.scope).toContain(
      'Captured chat and search assistants: none. Captured coding agents: none. Captured custom models: Grok 5 (acme/grok-5).',
    );
    expect(custom.ids).toContain(`market:${section.key}:custom:brand:mentions`);
    expect(custom.ids).not.toContain(
      `market:${section.key}:chat:brand:mentions`,
    );
    expect(chat.scope).not.toContain('custom models');
    expect(surfaceFamilyOf('custom:grok')).toBe('custom');
  });
});
