import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CapturedUnitRecord } from '../stores/ports';
import { copyFixtureConfig } from '../agents/__fixtures__/copy';
import type { CaptureArtifact } from '../harness/report/artifacts';
import {
  aggregateWorkdir,
  liftAnalyzedRun,
  metricsView,
  type AggregateOutput,
} from './aggregate';

const brand = { name: 'Deno Deploy', domain: 'deno.com', aliases: ['Deno'] };
const competitors = [
  { name: 'Vercel', domain: 'vercel.com', aliases: [] },
  { name: 'Render', domain: 'render.com', aliases: [] },
];

const record = {
  status: 'captured',
  sectionKey: 'hosting',
  promptId: 'h1',
  surface: 'perplexity',
  runIndex: 1,
  probe: {
    modelName: 'perplexity',
    runIndex: 1,
    text: 'Vercel is the common pick (https://vercel.com/docs); Deno Deploy works too. See https://docs.deno.com/deploy.',
  },
} as unknown as CapturedUnitRecord;

const row = {
  file: 'ANSWERS/hosting/h1/perplexity-1.md',
  prospectMentioned: true,
  prospectPosition: 'secondary' as const,
  prospectSentiment: 'positive' as const,
  contextSnippet: 'Deno Deploy works too.',
  competitorMentions: [
    { domain: 'vercel.com', mentioned: true, position: 'primary' as const },
  ],
  mentionedBrands: [
    { name: 'Vercel', domain: 'vercel.com' },
    { name: 'Deno Deploy', domain: 'deno.com' },
  ],
};

describe('Aggregate - liftAnalyzedRun()', () => {
  it('should take judgment from the row and citation from the answer text', () => {
    const run = liftAnalyzedRun(row, record, {
      promptIdx: 0,
      brand,
      competitors,
    });

    expect(run.clientMentioned).toBe(true);
    expect(run.clientPosition).toBe('secondary');
    expect(run.clientSentiment).toBe('positive');
    // docs.deno.com is on the brand domain; the judgment never decides this.
    expect(run.clientCited).toBe(true);
    expect(run.citedUrls).toEqual([
      'https://vercel.com/docs',
      'https://docs.deno.com/deploy',
    ]);
    // Every configured competitor gets a mention entry, judged or not.
    expect(run.competitorMentions).toEqual([
      { domain: 'vercel.com', mentioned: true, cited: true },
      { domain: 'render.com', mentioned: false, cited: false },
    ]);
    expect(run.surface).toBe('perplexity');
    expect(run.promptIdx).toBe(0);
  });

  it('should keep an empty snippet as null and the absent overview as an absence', () => {
    const absent = liftAnalyzedRun(
      {
        ...row,
        prospectMentioned: false,
        prospectPosition: 'absent',
        contextSnippet: '',
      },
      {
        ...record,
        probe: { ...record.probe, noOverview: true },
      },
      { promptIdx: 2, brand, competitors },
    );

    expect(absent.contextSnippet).toBeNull();
    expect(absent.noOverview).toBe(true);
  });
});

describe('Aggregate - metricsView()', () => {
  it('should keep captured coverage when every model judgment is unavailable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeo-unjudged-'));

    try {
      await mkdir(path.join(dir, 'OUT'));
      await writeFile(
        path.join(dir, 'OUT/analyze.json'),
        JSON.stringify({ rows: [] }),
      );
      await writeFile(
        path.join(dir, 'OUT/qualify.json'),
        JSON.stringify({ rows: [], corrections: [] }),
      );

      const result = await aggregateWorkdir({
        dir,
        config: {
          ...copyFixtureConfig,
          brand,
          competitors,
          sections: [
            {
              key: 'hosting',
              prompts: [
                {
                  id: 'h1',
                  text: 'Where should I host?',
                  category: 'product_recommendation',
                },
              ],
            },
          ],
        },
        surfaces: ['perplexity'],
        captured: [record],
        capture: {
          sections: {
            hosting: {
              units: [{}],
              coverage: [{ surface: 'perplexity', planned: 1, captured: 1 }],
              lostPromptIds: [],
              unitFailures: [],
              rejectedWebToolSurfaces: [],
              freshChatRetrieval: [],
              freshAgentRetrieval: [],
            },
          },
        } as unknown as CaptureArtifact,
      });

      expect(result.unjudged).toEqual([row.file]);
      expect(result.sections.hosting?.probeCount).toBe(1);
      expect(result.sections.hosting?.visibility.matrix).toEqual([]);
      expect(result.sections.hosting?.coverage).toEqual([
        { surface: 'perplexity', planned: 1, captured: 1 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('should count what a scrutiny pass can check against the rows', () => {
    const output = {
      version: 1,
      sections: {
        hosting: {
          visibility: {
            summary: {
              prospectShareOfVoice: 0.5,
              prospectCitationRate: 0.25,
              agentShareOfVoice: null,
              agentCitationRate: null,
              byModel: {},
              byCompetitor: [],
              topCompetitorDomain: 'vercel.com',
            },
            matrix: [
              {
                prospectMentioned: true,
                citedUrls: ['https://docs.deno.com/deploy'],
                qualifiedCompetitors: [
                  { name: 'Vercel', domain: 'vercel.com' },
                ],
              },
              {
                prospectMentioned: true,
                citedUrls: ['https://vercel.com/docs'],
                qualifiedCompetitors: [
                  { name: 'Vercel', domain: 'vercel.com' },
                  { name: 'Railway', domain: 'railway.com' },
                ],
              },
              { prospectMentioned: false, noOverview: true },
            ],
          },
          lostPromptIds: [],
          analysisFailures: [],
        },
      },
      unjudged: [],
    } as unknown as AggregateOutput;

    const view = metricsView(output, 'deno.com').sections.hosting;

    if (!view) {
      throw new Error('Expected a hosting section in the metrics view.');
    }

    expect(view.capturedAnswers).toBe(2);
    expect(view.prospectMentioned).toBe(2);
    // Mentioned and citing something else is not a prospect citation.
    expect(view.prospectCited).toBe(1);
    expect(view.qualifiedCompetitorCounts).toEqual([
      { name: 'Vercel', answers: 2 },
      { name: 'Railway', answers: 1 },
    ]);
  });
});
