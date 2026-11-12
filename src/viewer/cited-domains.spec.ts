import { describe, expect, it } from 'vitest';
import { groundingRedirectUrlPrefix } from '../report/core/grounding';
import type { AeoMatrixRow } from '../report/core/schema';
import { groupCitedDomains } from './cited-domains';

const row = (
  promptIdx: number,
  surface: AeoMatrixRow['surface'],
  citedUrls: string[],
): AeoMatrixRow => ({
  promptIdx,
  surface,
  prospectMentioned: false,
  prospectPosition: 'absent',
  contextSnippet: null,
  competitors: [],
  citedUrls,
});

const prompts = [
  { text: 'Which hosted databases suit a small team?', category: 'comparison' },
  { text: 'What is the cheapest managed database?', category: 'comparison' },
] as const;

describe('viewer - groupCitedDomains()', () => {
  it("should lead with the brand's domain even when no answer cites it", () => {
    const domains = groupCitedDomains(
      {
        prompts: [...prompts],
        matrix: [row(0, 'chatgpt', ['https://rivalstack.test/pricing'])],
      },
      'acmebase.test',
    );

    expect(
      domains.map(({ domain, count, isBrand }) => ({ domain, count, isBrand })),
    ).toEqual([
      { domain: 'acmebase.test', count: 0, isBrand: true },
      { domain: 'rivalstack.test', count: 1, isBrand: false },
    ]);
  });

  it("should split the brand's citations by host, and group every other host under its last two labels", () => {
    const domains = groupCitedDomains(
      {
        prompts: [...prompts],
        matrix: [
          row(0, 'chatgpt', [
            'https://acmebase.test/pricing',
            'https://docs.acmebase.test/start',
            'https://docs.acmebase.test/start',
            'https://www.reddit.test/r/databases',
          ]),
          row(1, 'perplexity', [
            'https://old.reddit.test/r/databases',
            'https://docs.acmebase.test/start',
          ]),
        ],
      },
      'acmebase.test',
    );

    expect(domains[0]).toEqual({
      domain: 'acmebase.test',
      count: 4,
      isBrand: true,
      hosts: [
        { label: 'docs', count: 3 },
        { label: 'site', count: 1 },
      ],
      urls: [
        {
          url: 'https://docs.acmebase.test/start',
          count: 3,
          surfaces: ['chatgpt', 'perplexity'],
          prompts: [prompts[0].text, prompts[1].text],
        },
        {
          url: 'https://acmebase.test/pricing',
          count: 1,
          surfaces: ['chatgpt'],
          prompts: [prompts[0].text],
        },
      ],
    });
    expect(domains[1]).toMatchObject({ domain: 'reddit.test', count: 2 });
  });

  it('should skip a grounding redirect that was never resolved', () => {
    const domains = groupCitedDomains(
      {
        prompts: [...prompts],
        matrix: [row(0, 'gemini', [`${groundingRedirectUrlPrefix}abc`])],
      },
      'acmebase.test',
    );

    expect(domains.map(({ domain }) => domain)).toEqual(['acmebase.test']);
  });
});
