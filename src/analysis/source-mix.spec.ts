import { describe, expect, it } from 'vitest';
import type { AeoVisibility } from '../schema';
import { buildSourceMix } from './source-mix';

const section = (
  key: string,
  row: Partial<AeoVisibility['matrix'][number]>,
) => {
  const visibility: AeoVisibility = {
    prompts: [{ text: 'Which agency?', category: 'product_recommendation' }],
    surfaces: ['chatgpt'],
    matrix: [
      {
        promptIdx: 0,
        surface: 'chatgpt',
        prospectMentioned: false,
        prospectPosition: 'absent',
        contextSnippet: null,
        competitors: [],
        ...row,
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
  };
  return { key, visibility };
};

describe('source-mix - buildSourceMix()', () => {
  it('should keep qualification local while preserving other learned source categories', () => {
    const sections = [
      section('software', {
        qualifiedCompetitors: [{ name: 'Tool', domain: 'tool.example' }],
        citedUrls: ['https://tool.example/a'],
      }),
      section('agencies', {
        mentionedBrands: [
          { name: 'Tool', domain: 'tool.example' },
          { name: 'ChatGPT', domain: 'chatgpt.com' },
        ],
        competitors: [{ domain: 'tool.example', mentioned: true }],
        qualifiedCompetitors: [{ name: 'Agency', domain: 'agency.example' }],
        citedUrls: [
          'https://tool.example/a',
          'https://agency.example/a',
          'https://chatgpt.com/about',
          'https://reddit.com/r/a',
        ],
      }),
    ];
    const result = buildSourceMix(sections, {
      brandDomain: 'literally.dev',
      competitorDomains: ['tool.example'],
      learned: {
        'tool.example': 'competitor',
        'agency.example': 'competitor',
        'chatgpt.com': 'institutional',
      },
    });

    expect(result.sections.map(({ key, total }) => ({ key, total }))).toEqual([
      {
        key: 'software',
        total: {
          owned: 0,
          competitor: 1,
          social: 0,
          institutional: 0,
          earned: 0,
        },
      },
      {
        key: 'agencies',
        total: {
          owned: 0,
          competitor: 1,
          social: 1,
          institutional: 1,
          earned: 1,
        },
      },
    ]);
  });

  it('should use each legacy section roster and never promote raw names', () => {
    const result = buildSourceMix(
      [
        section('first', {
          competitors: [{ domain: 'first.example', mentioned: false }],
          citedUrls: ['https://first.example/a', 'https://second.example/a'],
        }),
        section('second', {
          competitors: [{ domain: 'second.example', mentioned: false }],
          mentionedBrands: [{ name: 'ChatGPT', domain: 'chatgpt.com' }],
          citedUrls: ['https://second.example/a', 'https://chatgpt.com/about'],
        }),
      ],
      {
        brandDomain: 'literally.dev',
        competitorDomains: ['first.example', 'second.example'],
        learned: { 'chatgpt.com': 'competitor' },
      },
    );

    expect(result.sections.map((entry) => entry.total)).toEqual([
      { owned: 0, competitor: 1, social: 0, institutional: 0, earned: 1 },
      { owned: 0, competitor: 1, social: 0, institutional: 0, earned: 1 },
    ]);
  });
});
