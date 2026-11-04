import { aeoAuditConfigSchema, aeoSnapshotSchema } from '../../schema';

/** The synthetic two-section audit the copy tests share: a config, the
 * snapshot it measured, and drafts written against its fact catalog. No
 * client content. */
export const copyFixtureConfig = aeoAuditConfigSchema.parse({
  reportKey: 'synthetic',
  slug: 'synthetic-abcde',
  brand: { name: 'Example', domain: 'example.com' },
  competitors: [{ name: 'Other', domain: 'example.org' }],
  sections: ['first', 'second'].map((key) => ({
    key,
    prompts: Array.from({ length: 6 }, (_, index) => ({
      id: `p${index}`,
      text: `Which tools solve workflow ${index}?`,
      category: 'product_recommendation',
    })),
  })),
  moneyPages: ['https://example.com/docs'],
  productBrief: 'A synthetic developer tool.',
});

const [firstFixtureSection] = copyFixtureConfig.sections;

if (!firstFixtureSection) {
  throw new Error('Copy fixture config has no sections.');
}

export const copyFixtureSnapshot = aeoSnapshotSchema.parse({
  version: 2,
  reportKey: copyFixtureConfig.reportKey,
  brand: copyFixtureConfig.brand,
  competitors: copyFixtureConfig.competitors,
  sections: copyFixtureConfig.sections.map(({ key }) => ({
    key,
    visibility: {
      prompts: firstFixtureSection.prompts,
      surfaces: ['chatgpt', 'gemini'],
      matrix: [
        {
          promptIdx: 0,
          surface: 'gemini',
          prospectMentioned: true,
          prospectPosition: 'primary',
          contextSnippet: null,
          citedUrls: ['https://example.com/docs'],
          competitors: [],
        },
      ],
      summary: {
        prospectShareOfVoice: 0.1,
        prospectCitationRate: 0.1,
        agentShareOfVoice: null,
        agentCitationRate: null,
        byModel: {},
        byCompetitor: [],
        topCompetitorDomain: null,
      },
    },
  })),
  meta: {
    generatedAt: '2026-09-08T12:00:00.000Z',
    promptCount: 12,
    probeCount: 2,
    partialFailures: [],
    surfaces: ['chatgpt', 'gemini'],
    runId: 'run-1',
    analyzerVersion: 4,
    domainClassifierVersion: 2,
  },
});

export const narrativeDraft = (
  text = 'Example appeared in one of the twelve Gemini answers for the first set of questions. That gives this report a specific starting point for understanding its visibility.',
) => {
  return {
    intro: [
      {
        kind: 'narrative',
        text,
        basisFactIds: ['first:gemini:mentions'],
        premises: [
          {
            proposition:
              'Gemini mentioned Example in one of twelve planned answers in the first section.',
            basisFactIds: ['first:gemini:mentions'],
          },
        ],
      },
    ],
    sections: Object.fromEntries(
      copyFixtureConfig.sections.map(({ key }) => [key, { subtitle: [] }]),
    ),
    confidence: 0.9,
  };
};

export const finalDraft = () => {
  const insight = narrativeDraft();

  return {
    ...insight,
    hero: {
      title: {
        ...insight.intro[0],
        text: 'Where Example appears in AI answers about workflow tools',
      },
      subtitle: {
        kind: 'narrative',
        text: 'We tested whether Gemini names Example when asked to choose tools for workflow tasks. This report shows where it appeared in the answers we captured.',
        basisFactIds: ['scope:first:questions', 'first:gemini:mentions'],
        premises: [
          {
            proposition:
              'This audit asked workflow tool questions and measured whether Gemini mentioned Example.',
            basisFactIds: ['scope:first:questions', 'first:gemini:mentions'],
          },
        ],
      },
    },
  };
};
