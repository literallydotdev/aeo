import { assert, describe, expect, it, vi } from 'vitest';
import {
  codingAgentsContradiction,
  validateAuthorOutput,
} from './author-validation';

const output = {
  brand: { name: 'Example', domain: 'example.com' },
  competitors: [
    { name: 'Other', domain: 'example.org' },
    { name: 'Another', domain: 'example.net' },
  ],
  sections: [
    {
      key: 'tools',
      prompts: Array.from({ length: 6 }, (_, index) => ({
        id: `p${index}`,
        text: `Which tools solve workflow ${index}?`,
        category: 'product_recommendation',
      })),
    },
  ],
  moneyPages: ['https://docs.example.com/'],
  productBrief: 'Synthetic tool',
};
const notes = {
  verdict: 'fit',
  confidence: 0.9,
  reasons: ['Synthetic fit evidence'],
  briefContradiction: false,
};
const input = {
  output,
  notes,
  reportKey: 'example',
  slug: 'example-abcde',
  website: 'https://example.com',
  protectedClientHosts: [],
  reachability: () => Promise.resolve('reachable' as const),
};

describe('author-validation - validateAuthorOutput()', () => {
  it('should accept on-domain/subdomain identity and bot-protected reachability', async () => {
    const result = await validateAuthorOutput(input);

    expect(result.errors).toEqual([]);
    expect(result.flags).toEqual([]);
  });

  it.each([
    'The customer brief states that Example supplies fresh produce to restaurants; this is unverified.',
    'According to the submitted brief, Example supplies fresh produce.',
    'Unknown at submission and therefore not asserted: delivery cut-off times.',
  ])(
    'should require repair before researching a claim about the brief: %s',
    async (proposition) => {
      const reachability = vi.fn(input.reachability);

      const result = await validateAuthorOutput({
        ...input,
        reachability,
        notes: {
          ...notes,
          proposedFacts: [
            {
              proposition,
              scope: {
                product: 'Example wholesale supply',
                generation: null,
                version: null,
                applicableAt: null,
              },
              category: 'capability',
              sourceUrls: ['https://example.com/'],
            },
          ],
        },
      });

      expect(result.config).toBeUndefined();
      expect(result.fatal).toBeUndefined();
      expect(result.errors).toEqual([
        expect.stringContaining(
          'proposedFacts.0.proposition: State a direct product or service claim',
        ),
      ]);
      expect(reachability).not.toHaveBeenCalled();
    },
  );

  it('should preserve product qualifiers and allow brief provenance in reasons', async () => {
    const fact = {
      proposition:
        'Example supplies seasonal produce to restaurant kitchens in London on request from September 2026.',
      scope: {
        product: 'Example wholesale supply',
        generation: null,
        version: null,
        applicableAt: '2026-09-01T00:00:00.000Z',
      },
      category: 'capability',
      sourceUrls: ['https://example.com/'],
    };

    const result = await validateAuthorOutput({
      ...input,
      notes: {
        ...notes,
        reasons: [
          'The customer brief states this; website verification is still required.',
        ],
        proposedFacts: [fact],
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.notes?.proposedFacts).toEqual([fact]);
  });

  it('should fail mismatched identity and protected clients before any repairable check', async () => {
    const reachability = vi.fn(input.reachability);
    const thirdParty = {
      ...output,
      brand: { name: 'Third party', domain: 'evil.example.net' },
    };

    const wrongHost = await validateAuthorOutput({
      ...input,
      reachability,
      output: thirdParty,
    });
    // A wrong host with one attributed claim dies now rather than after a
    // repair session spent on the claim.
    const mismatched = await validateAuthorOutput({
      ...input,
      reachability,
      output: thirdParty,
      notes: {
        ...notes,
        proposedFacts: [
          {
            proposition: 'The customer brief states that Example ships daily.',
            scope: {
              product: 'Example',
              generation: null,
              version: null,
              applicableAt: null,
            },
            category: 'capability',
            sourceUrls: ['https://example.com/'],
          },
        ],
      },
    });
    const protectedClient = await validateAuthorOutput({
      ...input,
      protectedClientHosts: ['example.org'],
    });

    expect(wrongHost.fatal).toBe('brief_mismatch');
    expect(mismatched.fatal).toBe('brief_mismatch');
    expect(mismatched.errors).not.toContainEqual(
      expect.stringContaining('proposedFacts.0.proposition'),
    );
    expect(reachability).not.toHaveBeenCalled();
    expect(protectedClient.fatal).toBe('brief_mismatch');
  });

  it('should distinguish competitor HTTP failures from unresolved hosts', async () => {
    const unreachable = await validateAuthorOutput({
      ...input,
      reachability: () => Promise.resolve('unreachable' as const),
    });
    const unresolved = await validateAuthorOutput({
      ...input,
      reachability: () => Promise.resolve('unresolved' as const),
    });

    expect(unreachable.flags).not.toContain('competitor_domain_unresolved');
    expect(unresolved.flags).toContain('competitor_domain_unresolved');
  });

  it('should flag brand awareness, low confidence, and undersized prompt sets', async () => {
    const result = await validateAuthorOutput({
      ...input,
      notes: { ...notes, confidence: 0.1 },
      output: {
        ...output,
        sections: [
          {
            key: 'tools',
            prompts: [
              {
                id: 'x',
                text: 'What is Example?',
                category: 'general_knowledge',
              },
            ],
          },
        ],
      },
    });

    expect(result.flags).toEqual(
      expect.arrayContaining([
        'brand_awareness_prompt_detected',
        'low_confidence',
        'prompt_count_out_of_range',
      ]),
    );
  });

  it('should flag more than two sections for a reviewer', async () => {
    const [firstSection] = output.sections;

    assert(firstSection);

    const section = (key: string) => {
      return { ...firstSection, key };
    };

    const two = await validateAuthorOutput({
      ...input,
      output: { ...output, sections: [section('a'), section('b')] },
    });
    const three = await validateAuthorOutput({
      ...input,
      output: {
        ...output,
        sections: [section('a'), section('b'), section('c')],
      },
    });

    expect(two.flags).not.toContain('section_count_out_of_range');
    expect(three.flags).toContain('section_count_out_of_range');
    expect(three.config).toBeDefined();
  });

  it('should parse a config without a surfaces decision as measuring every surface', async () => {
    const result = await validateAuthorOutput(input);

    expect(result.config?.surfaces.codingAgents).toBe('measure');
  });

  it('should reject guessed human-only fields and complete credentials', async () => {
    const withGrounding = await validateAuthorOutput({
      ...input,
      output: { ...output, productGrounding: { facts: [] } },
    });
    const withReadiness = await validateAuthorOutput({
      ...input,
      output: {
        ...output,
        agentReadiness: { mcpServer: true, llmDocs: true },
      },
    });
    const withCredential = await validateAuthorOutput({
      ...input,
      output: { ...output, productBrief: `aeo_prod_${'a'.repeat(43)}` },
    });

    expect(withGrounding.errors.length).toBeGreaterThan(0);
    expect(withReadiness.errors.length).toBeGreaterThan(0);
    expect(withCredential.fatal).toBe('credential_detected');
  });
});

describe('author-validation - validateAuthorOutput() research rules', () => {
  // Codex author spec §5.
  const fact = (url: string) => {
    return {
      proposition: 'Example reviews database changes for teams.',
      scope: {
        product: 'Example',
        generation: null,
        version: null,
        applicableAt: null,
      },
      category: 'capability',
      sourceUrls: [url],
    };
  };
  const brief = {
    companyName: 'Example',
    desiredRecommendation: 'The developer tool for reviewing database changes',
  };
  const research = {
    fetchedUrls: ['https://example.com/', 'https://example.com/docs/'],
    documents: [
      'Example Tools reviews database changes. Compare with Other (example.org).',
      'Docs mention Another at example.net.',
    ],
    successfulFetches: 2,
  };

  it('should refuse a fact citing a page the session never read, and accept one it did', async () => {
    const refused = await validateAuthorOutput({
      ...input,
      brief,
      research,
      notes: { ...notes, proposedFacts: [fact('https://example.com/pricing')] },
    });
    const accepted = await validateAuthorOutput({
      ...input,
      brief,
      research,
      // Canonical comparison: the trailing slash and the hash do not matter.
      notes: {
        ...notes,
        proposedFacts: [fact('https://example.com/docs#top')],
      },
    });

    expect(refused.config).toBeUndefined();
    expect(refused.errors).toEqual([
      expect.stringContaining(
        'proposedFacts.0.sourceUrls: cite only what you read',
      ),
    ]);
    expect(accepted.errors).toEqual([]);
    expect(accepted.flags).toEqual([]);
  });

  it('should flag a competitor neither the brief nor the research supports', async () => {
    const supported = await validateAuthorOutput({ ...input, brief, research });
    const unsupported = await validateAuthorOutput({
      ...input,
      brief,
      research: { ...research, documents: ['Nothing about them.'] },
    });
    const inBrief = await validateAuthorOutput({
      ...input,
      brief: { ...brief, competitors: 'Other and Another' },
      research: { ...research, documents: ['Nothing about them.'] },
    });
    // Reading the competitor's own site supports it even when the page
    // text never spells its configured name or domain (the live
    // superlinked.com run: "Hugging Face Text Embeddings Inference" read on
    // huggingface.co, whose docs page says neither string verbatim).
    const siteRead = await validateAuthorOutput({
      ...input,
      brief,
      research: {
        fetchedUrls: [
          'https://example.com/',
          'https://www.example.org/pricing',
          'https://docs.example.net/start',
        ],
        documents: ['Nothing about them.'],
        successfulFetches: 3,
      },
    });

    expect(supported.flags).not.toContain('competitors_unsupported');
    expect(unsupported.flags).toContain('competitors_unsupported');
    expect(inBrief.flags).not.toContain('competitors_unsupported');
    expect(siteRead.flags).not.toContain('competitors_unsupported');
  });

  it('should flag a session that read nothing', async () => {
    const result = await validateAuthorOutput({
      ...input,
      brief,
      research: { fetchedUrls: [], documents: [], successfulFetches: 0 },
    });

    expect(result.flags).toEqual(
      expect.arrayContaining(['research_empty', 'competitors_unsupported']),
    );
    expect(result.config).toBeDefined();
  });

  it('should flag a coding-agent decision that contradicts the evidence', async () => {
    const skipCodingAgents = {
      ...output,
      surfaces: {
        codingAgents: 'skip',
        because: 'Buyers are artists, not developers.',
      },
    };

    const flagged = await validateAuthorOutput({
      ...input,
      brief: {
        companyName: 'Example',
        desiredRecommendation: 'The SDK developers reach for first',
      },
      output: skipCodingAgents,
    });
    const clean = await validateAuthorOutput({
      ...input,
      brief: {
        companyName: 'Glass',
        desiredRecommendation: 'Pattern software for stained-glass artists',
      },
      output: skipCodingAgents,
    });

    expect(flagged.flags).toContain('coding_agents_contradiction');
    expect(clean.flags).not.toContain('coding_agents_contradiction');
  });
});

describe('author-validation - codingAgentsContradiction()', () => {
  const technical = {
    companyName: 'Example',
    desiredRecommendation: 'The SDK developers reach for first',
  };
  const artists = {
    companyName: 'Glass',
    desiredRecommendation: 'Pattern software for stained-glass artists',
  };

  it('should flag skipping coding agents for a technical brief', () => {
    expect(
      codingAgentsContradiction({ decision: 'skip', brief: technical }),
    ).toBe(true);
    expect(
      codingAgentsContradiction({ decision: 'measure', brief: technical }),
    ).toBe(false);
  });

  it('should flag measuring coding agents for a non-technical brief', () => {
    expect(
      codingAgentsContradiction({ decision: 'skip', brief: artists }),
    ).toBe(false);
    expect(
      codingAgentsContradiction({ decision: 'measure', brief: artists }),
    ).toBe(true);
  });

  it('should count research documents as evidence', () => {
    // A docs page names the developer.
    const result = codingAgentsContradiction({
      decision: 'measure',
      brief: artists,
      documents: ['Our API and SDK let developers build on it.'],
    });

    expect(result).toBe(false);
  });
});
