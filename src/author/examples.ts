import { literally2026Q3 } from '../configs/literally-2026-q3';
import { authorOutputSchema } from '../agents/author-schema';

// ============================================================================
// The two example configs every author sees: the self-audit and a synthetic
// one. Never the registry: bundling it would disclose every client's product
// brief and competitor roster wherever the author runs.
// ============================================================================

export const syntheticExample = {
  brand: { name: 'Example Tools', domain: 'example.com', aliases: [] },
  competitors: [
    { name: 'Sample One', domain: 'example.org', aliases: [] },
    { name: 'Sample Two', domain: 'example.net', aliases: [] },
  ],
  sections: [
    {
      key: 'developer_tools',
      prompts: [
        'Which tools help a small team review database changes?',
        'How can a platform team check schema migration risks?',
        'What tools compare staging and production schemas?',
        'How can developers document database change approvals?',
        'Which migration tools fit a Postgres development workflow?',
        'How can teams test database rollbacks before release?',
      ].map((text, index) => ({
        id: `tool-choice-${index + 1}`,
        category: 'product_recommendation',
        text,
      })),
    },
  ],
  productBrief: 'Synthetic developer tool for reviewing database changes.',
  moneyPages: ['https://example.com/docs'],
  surfaces: {
    codingAgents: 'measure',
    because:
      'Buyers are developers and platform engineers who evaluate it from inside their database workflow.',
  },
};

export const authorExampleNames = ['literally', 'synthetic'] as const;

export type AuthorExampleName = (typeof authorExampleNames)[number];

export const isAuthorExampleName = (
  value: string,
): value is AuthorExampleName => {
  return authorExampleNames.some((name) => name === value);
};

/** The example files, by name, as JSON text. */
export const authorExamples = (
  names: readonly AuthorExampleName[] = authorExampleNames,
): Record<string, string> => {
  const files: Record<string, string> = {};

  if (names.includes('literally')) {
    const {
      reportKey: _reportKey,
      slug: _slug,
      agentReadiness: _readiness,
      sourceOverrides: _overrides,
      ...example
    } = literally2026Q3;

    files['literally.json'] = JSON.stringify(
      authorOutputSchema.parse(example),
      null,
      2,
    );
  }

  if (names.includes('synthetic')) {
    files['synthetic.json'] = JSON.stringify(syntheticExample, null, 2);
  }

  return files;
};
