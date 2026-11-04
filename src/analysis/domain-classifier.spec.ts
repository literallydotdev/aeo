import { afterEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { testModelProfileFixture } from '../models/profile-fixture';
import type { AeoVisibility, SourceCategory } from '../schema';
import { createMemoryModelAccounting } from '../models/accounting';
import { internalModelRoleDigest } from '../models/profiles';
import type { StructuredTransport } from '../models/structured';
import {
  domainClassifierVersion,
  acceptModelLabels,
  analyzerBrandDomains,
  buildDomainLabelsFile,
  registrableDomain,
  collectUnlabeledHosts,
  learnDomainLabels,
  learnedLabels,
  reusableModelLabels,
} from './domain-classifier';
import type { SourceClassifierConfig } from './source-classifier';

const staticClassifierConfig: SourceClassifierConfig = {
  brandDomain: 'literally.dev',
  competitorDomains: ['draft.dev'],
};

const row = (
  citedUrls: string[],
  mentionedBrands: Array<{ name: string; domain: string | null }> = [],
): AeoVisibility['matrix'][number] => {
  return {
    promptIdx: 0,
    surface: 'claude',
    prospectMentioned: false,
    prospectPosition: 'absent',
    contextSnippet: null,
    citedUrls,
    mentionedBrands,
    competitors: [{ domain: 'draft.dev', mentioned: false }],
  };
};

const section = (matrix: AeoVisibility['matrix']) => {
  return {
    key: 'aeo_agencies',
    visibility: {
      prompts: [
        {
          text: 'Best AEO agencies?',
          category: 'product_recommendation' as const,
        },
      ],
      surfaces: ['claude' as const],
      matrix,
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
  };
};

describe('domain-classifier - analyzerBrandDomains()', () => {
  it('should collect qualified domains and drops the client, blanks, and raw-only brands', () => {
    const sections = [
      section([
        {
          ...row([], [{ name: 'ChatGPT', domain: 'chatgpt.com' }]),
          qualifiedCompetitors: [
            { name: 'Infrasity', domain: 'https://www.infrasity.com/' },
            { name: 'Literally.dev', domain: 'literally.dev' },
            { name: 'Growthner', domain: null },
            { name: 'Perceptric', domain: 'Perceptric.com' },
            { name: 'Nonsense', domain: 'nodot' },
          ],
        },
      ]),
    ];

    expect(analyzerBrandDomains(sections, 'literally.dev')).toEqual([
      'infrasity.com',
      'perceptric.com',
    ]);
  });

  it('should use only mentioned configured competitors on legacy rows and respects explicit exclusions', () => {
    const legacy = {
      ...row([], [{ name: 'ChatGPT', domain: 'chatgpt.com' }]),
      competitors: [{ domain: 'draft.dev', mentioned: true }],
    };

    expect(analyzerBrandDomains([section([legacy])], 'literally.dev')).toEqual([
      'draft.dev',
    ]);
    expect(
      analyzerBrandDomains(
        [section([{ ...legacy, qualifiedCompetitors: [] }])],
        'literally.dev',
      ),
    ).toEqual([]);
  });
});

describe('domain-classifier - collectUnlabeledHosts()', () => {
  it('should return earned hosts most-cited first with sample paths', () => {
    const sections = [
      section([
        row([
          'https://www.infrasity.com/blog/best-aeo-agencies',
          'https://infrasity.com/',
          'https://draft.dev/learn/x',
          'https://reddit.com/r/x',
          'https://europeanbusinessreview.com/story',
          'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
        ]),
      ]),
    ];
    const hosts = collectUnlabeledHosts(sections, staticClassifierConfig);

    expect(hosts.map((h) => h.host)).toEqual([
      'infrasity.com',
      'europeanbusinessreview.com',
    ]);
    expect(hosts[0]).toEqual({
      host: 'infrasity.com',
      citations: 2,
      samplePaths: ['/blog/best-aeo-agencies'],
    });
  });

  it('should honour learned labels already on the config', () => {
    const sections = [section([row(['https://infrasity.com/a'])])];

    expect(
      collectUnlabeledHosts(sections, {
        ...staticClassifierConfig,
        learned: { 'infrasity.com': 'competitor' },
      }),
    ).toEqual([]);
  });

  it('should NOT let a host-only model restore a contextually excluded competitor', () => {
    const sections = [
      section([
        {
          ...row(
            ['https://chatgpt.com/about'],
            [{ name: 'ChatGPT', domain: 'chatgpt.com' }],
          ),
          qualifiedCompetitors: [],
        },
      ]),
    ];
    const hosts = collectUnlabeledHosts(sections, {
      ...staticClassifierConfig,
      learned: { 'chatgpt.com': 'competitor' },
    });

    expect(hosts).toEqual([
      {
        host: 'chatgpt.com',
        citations: 1,
        samplePaths: ['/about'],
        competitorAllowed: false,
      },
    ]);
    expect(
      acceptModelLabels(hosts, [
        { domain: 'chatgpt.com', category: 'competitor' },
      ]).labels,
    ).toEqual({ 'chatgpt.com': 'earned' });
    expect(
      acceptModelLabels(hosts, [
        { domain: 'chatgpt.com', category: 'institutional' },
      ]).labels,
    ).toEqual({ 'chatgpt.com': 'institutional' });
  });
});

describe('domain-classifier - buildDomainLabelsFile()', () => {
  it('should reuse only model labels at the current version', () => {
    const file = buildDomainLabelsFile({
      analyzerDomains: ['infrasity.com'],
      modelLabels: { 'zenn.dev': 'social', 'g2.com': 'earned' },
    });

    expect(reusableModelLabels(file)).toEqual({
      'zenn.dev': 'social',
      'g2.com': 'earned',
    });
    expect(
      reusableModelLabels({ ...file, version: domainClassifierVersion + 1 }),
    ).toEqual({});
    expect(reusableModelLabels(null)).toEqual({});
    expect(reusableModelLabels({ ...file, version: 1 })).toEqual({});
  });

  it('should record the pinned classifier model and reuses labels only from that model', () => {
    const pinned = testModelProfileFixture();
    const other = {
      ...pinned,
      roles: {
        ...pinned.roles,
        domainClassifier: {
          ...pinned.roles.domainClassifier,
          model: 'provider/another-model',
        },
      },
    };
    const context = (profile: typeof pinned) => {
      return {
        profile,
        accounting: createMemoryModelAccounting({
          maxUsd: 1,
          maxTokens: 10_000,
          deadlineAt: '2099-01-01T00:00:00.000Z',
        }),
      };
    };
    const file = buildDomainLabelsFile({
      analyzerDomains: [],
      modelLabels: { 'zenn.dev': 'social' },
      model: pinned.roles.domainClassifier.model,
      contextHash: 'ctx',
      modelProfileDigest: internalModelRoleDigest(
        pinned.roles.domainClassifier,
      ),
    });

    expect(file.model).toBe(pinned.roles.domainClassifier.model);
    expect(reusableModelLabels(file, context(pinned), 'ctx')).toEqual({
      'zenn.dev': 'social',
    });
    expect(reusableModelLabels(file, context(other), 'ctx')).toEqual({});
    // Without a pinned profile the legacy Opus default still applies.
    expect(reusableModelLabels(file)).toEqual({});
    expect(
      buildDomainLabelsFile({ analyzerDomains: [], modelLabels: {} }).model,
    ).toBe('anthropic/claude-opus-4.6');
  });

  it('should settle a configured competitor domain as competitor over the model', () => {
    // Run A, 2026-09-12: the model labelled vercel.com "institutional" while
    // Vercel was a configured competitor of the section.
    const file = buildDomainLabelsFile({
      analyzerDomains: [],
      configuredDomains: ['https://www.Vercel.com/'],
      modelLabels: { 'vercel.com': 'institutional' },
    });

    expect(file.entries['vercel.com']).toEqual({
      category: 'competitor',
      source: 'config',
    });
    // Every judged host under the competitor's registrable domain.
    const cloudflare = buildDomainLabelsFile({
      analyzerDomains: [],
      configuredDomains: ['workers.cloudflare.com'],
      modelLabels: {
        'cloudflare.com': 'institutional',
        'developers.cloudflare.com': 'institutional',
        'cf-assets.www.cloudflare.com': 'competitor',
        'example.co.uk': 'earned',
      },
    });

    expect(cloudflare.entries['cloudflare.com']?.source).toBe('config');
    expect(cloudflare.entries['developers.cloudflare.com']?.category).toBe(
      'competitor',
    );
    expect(cloudflare.entries['example.co.uk']?.source).toBe('model');
    expect(registrableDomain('docs.example.co.uk')).toBe('example.co.uk');
    // A configured domain the model never judged gets no entry.
    expect(
      buildDomainLabelsFile({
        analyzerDomains: [],
        configuredDomains: ['render.com'],
        modelLabels: {},
      }).entries,
    ).toEqual({});
  });

  it('should let an analyzer label win over a cached model label and sorts hosts', () => {
    const file = buildDomainLabelsFile({
      analyzerDomains: ['b.com'],
      modelLabels: { 'b.com': 'earned', 'a.com': 'social' },
    });

    expect(Object.keys(file.entries)).toEqual(['a.com', 'b.com']);
    expect(file.entries['b.com']).toEqual({
      category: 'competitor',
      source: 'analyzer',
    });
    expect(learnedLabels(file)).toEqual({
      'a.com': 'social',
      'b.com': 'competitor',
    });
  });
});

describe('domain-classifier - learnDomainLabels()', () => {
  afterEach(() => vi.useRealTimers());

  const sections = [
    section([row(['https://a.com/x', 'https://b.com/y', 'https://c.com/z'])]),
  ];
  const context = {
    brandName: 'Literally',
    brandDomain: 'literally.dev',
    productBrief: 'Technical content agency',
    promptTexts: ['Best AEO agencies?'],
  };
  /** What one call returns, by host: a label, or an error to throw. */
  type Step = Record<string, SourceCategory> | Error;
  const run = (script: Step[]) => {
    const calls: string[][] = [];
    const transport: StructuredTransport = (input) => {
      const hosts = [...input.prompt.matchAll(/^- (\S+) /gm)].flatMap(
        ([, host]) => (host === undefined ? [] : [host]),
      );
      const step = script[calls.length];

      calls.push(hosts);

      if (step instanceof Error) {
        return Promise.reject(step);
      }

      const results = hosts.flatMap((host) => {
        const category = step?.[host];

        return category ? [{ domain: host, category }] : [];
      });

      return Promise.resolve({
        output: input.schema.parse({ results }),
        usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 50 },
      });
    };

    const learned = learnDomainLabels({
      sections,
      staticConfig: staticClassifierConfig,
      context,
      previous: null,
      internalModels: {
        profile: testModelProfileFixture(),
        accounting: createMemoryModelAccounting({
          maxUsd: 50,
          maxTokens: 1_000_000,
          deadlineAt: '2099-01-01T00:00:00.000Z',
        }),
        transport,
      },
    });

    return { learned, calls };
  };

  it('should ask again for only the hosts the model skipped and keep every label learned', async () => {
    const { learned, calls } = run([
      { 'a.com': 'social' },
      { 'b.com': 'competitor' },
      {},
    ]);
    const result = await learned;

    // Each round carries the hosts still unlabelled; the third answers
    // nothing about c.com, so its `earned` default stands and is reported.
    expect(calls).toEqual([
      ['a.com', 'b.com', 'c.com'],
      ['b.com', 'c.com'],
      ['c.com'],
    ]);
    expect(result.learned).toEqual({
      'a.com': 'social',
      'b.com': 'competitor',
    });
    expect(result.stats).toMatchObject({ modelLabelsNew: 2, modelSkipped: 1 });
    expect(result.failures).toEqual([
      'batch 0: model skipped 1 of 3 hosts (c.com); they stay earned',
    ]);
  });

  it('should keep the labels of earlier rounds when a later round fails at the transport', async () => {
    vi.useFakeTimers();

    const unavailable = () => {
      return new APICallError({
        message: 'Unavailable',
        url: 'https://example.invalid',
        requestBodyValues: {},
        statusCode: 503,
      });
    };
    const { learned, calls } = run([
      { 'a.com': 'social' },
      unavailable(),
      unavailable(),
      unavailable(),
    ]);
    await vi.runAllTimersAsync();
    const result = await learned;

    // The retries carry the two unlabelled hosts alone; a.com keeps its label.
    expect(calls).toEqual([
      ['a.com', 'b.com', 'c.com'],
      ['b.com', 'c.com'],
      ['b.com', 'c.com'],
      ['b.com', 'c.com'],
    ]);
    expect(result.learned).toEqual({ 'a.com': 'social' });
    expect(result.failures).toEqual([
      'batch 0 (2 of 3 hosts unlabelled) failed after retries: Unavailable',
    ]);
  });
});

describe('domain-classifier - acceptModelLabels()', () => {
  it('should keep only batch hosts, reject owned, and report skipped hosts', () => {
    const hosts = [
      { host: 'a.com', citations: 1, samplePaths: [] },
      { host: 'b.com', citations: 1, samplePaths: [] },
      { host: 'c.com', citations: 1, samplePaths: [] },
    ];
    const { labels, missing } = acceptModelLabels(hosts, [
      { domain: 'www.a.com', category: 'competitor' },
      { domain: 'b.com', category: 'owned' },
      { domain: 'stranger.com', category: 'social' },
      { domain: 'a.com', category: 'earned' },
    ]);

    expect(labels).toEqual({ 'a.com': 'competitor' });
    expect(missing).toEqual(['b.com', 'c.com']);
  });
});
