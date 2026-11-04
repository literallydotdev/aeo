import { describe, expect, it } from 'vitest';
import type { AeoVisibility } from '../schema';
import { deriveOutreachTargets } from './outreach';

const classifierConfig = {
  brandDomain: 'superlinked.com',
  competitorDomains: ['pinecone.io'],
};

type MatrixRow = AeoVisibility['matrix'][number];

const matrixRow = (overrides: Partial<MatrixRow>): MatrixRow => {
  return {
    promptIdx: 0,
    surface: 'chatgpt',
    prospectMentioned: false,
    prospectPosition: 'absent',
    contextSnippet: null,
    competitors: [],
    ...overrides,
  };
};

const section = (matrix: MatrixRow[], key = 'vector_search') => {
  const visibility: AeoVisibility = {
    prompts: [
      { text: 'Prompt 0', category: 'comparison' },
      { text: 'Prompt 1', category: 'comparison' },
    ],
    surfaces: ['chatgpt'],
    matrix,
    summary: {
      prospectShareOfVoice: 0,
      prospectCitationRate: 0,
      agentShareOfVoice: null,
      agentCitationRate: null,
      byModel: {},
      byCompetitor: [],
      topCompetitorDomain: null,
    },
  };
  return { key, visibility };
};

describe('outreach - deriveOutreachTargets()', () => {
  it('should surface earned domains cited where the client is absent and a competitor wins', () => {
    const targets = deriveOutreachTargets(
      [
        section([
          matrixRow({
            competitors: [{ domain: 'pinecone.io', mentioned: true }],
            citedUrls: [
              'https://press.example.com/best-vector-dbs',
              'https://www.pinecone.io/learn/', // competitor — excluded
              'https://superlinked.com/comparison', // owned — excluded
              'https://reddit.com/r/rag/x', // social — excluded
            ],
          }),
          matrixRow({
            promptIdx: 1,
            competitors: [{ domain: 'pinecone.io', mentioned: true }],
            citedUrls: ['https://press.example.com/best-vector-dbs'],
          }),
        ]),
      ],
      classifierConfig,
    );

    expect(targets).toEqual([
      {
        domain: 'press.example.com',
        citations: 2,
        prompts: [
          { sectionKey: 'vector_search', promptIdx: 0 },
          { sectionKey: 'vector_search', promptIdx: 1 },
        ],
        sampleUrls: ['https://press.example.com/best-vector-dbs'],
      },
    ]);
  });

  it('should ignore runs where the client is mentioned or nobody else is', () => {
    const targets = deriveOutreachTargets(
      [
        section([
          matrixRow({
            prospectMentioned: true,
            competitors: [{ domain: 'pinecone.io', mentioned: true }],
            citedUrls: ['https://press.example.com/a'],
          }),
          matrixRow({
            promptIdx: 1,
            competitors: [{ domain: 'pinecone.io', mentioned: false }],
            citedUrls: ['https://press.example.com/b'],
          }),
        ]),
      ],
      classifierConfig,
    );

    expect(targets).toEqual([]);
  });

  it('should count a newly qualified competitor as a competitor win', () => {
    const targets = deriveOutreachTargets(
      [
        section([
          matrixRow({
            mentionedBrands: [{ name: 'Qdrant', domain: 'qdrant.tech' }],
            qualifiedCompetitors: [{ name: 'Qdrant', domain: 'qdrant.tech' }],
            citedUrls: ['https://press.example.com/c'],
          }),
        ]),
      ],
      classifierConfig,
    );

    expect(targets.map((t) => t.domain)).toEqual(['press.example.com']);
  });

  it('should NOT count a raw platform mention or an explicitly excluded seed as a competitor win', () => {
    const raw = matrixRow({
      mentionedBrands: [{ name: 'ChatGPT', domain: 'chatgpt.com' }],
      citedUrls: ['https://press.example.com/a'],
    });

    expect(
      deriveOutreachTargets(
        [
          section([
            raw,
            {
              ...raw,
              competitors: [{ domain: 'pinecone.io', mentioned: true }],
              qualifiedCompetitors: [],
            },
          ]),
        ],
        classifierConfig,
      ),
    ).toEqual([]);
  });

  it('should NOT let another section qualify an unrelated cited domain', () => {
    const first = section([
      matrixRow({
        qualifiedCompetitors: [{ name: 'Qdrant', domain: 'qdrant.tech' }],
        citedUrls: ['https://qdrant.tech/a'],
      }),
    ]);
    const second = section(
      [
        matrixRow({
          mentionedBrands: [{ name: 'Qdrant', domain: 'qdrant.tech' }],
          qualifiedCompetitors: [{ name: 'Agency', domain: 'agency.example' }],
          citedUrls: ['https://qdrant.tech/a', 'https://agency.example/a'],
        }),
      ],
      'agencies',
    );

    expect(
      deriveOutreachTargets([first, second], {
        ...classifierConfig,
        learned: {
          'qdrant.tech': 'competitor',
          'agency.example': 'competitor',
        },
      }),
    ).toEqual([
      {
        domain: 'qdrant.tech',
        citations: 1,
        prompts: [{ sectionKey: 'agencies', promptIdx: 0 }],
        sampleUrls: ['https://qdrant.tech/a'],
      },
    ]);
  });
});
