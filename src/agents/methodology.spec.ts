import { describe, expect, it } from 'vitest';
import { aeoSnapshotSchema, aeoVisibilitySchema } from '../report/core/schema';
import { buildMethodology, type MethodologyInput } from './methodology';

const visibility = (withEvidence: boolean) => {
  const evidence = { count: 2, captured: 8, planned: 8, low: 0.07, high: 0.6 };

  return aeoVisibilitySchema.parse({
    prompts: [],
    surfaces: ['chatgpt'],
    matrix: [],
    summary: {
      prospectShareOfVoice: 0.25,
      prospectCitationRate: 0.25,
      agentShareOfVoice: null,
      agentCitationRate: null,
      byModel: {
        chatgpt: {
          shareOfVoice: 0.25,
          citationRate: 0.25,
          ...(withEvidence && { shareOfVoiceEvidence: evidence }),
        },
      },
      byCompetitor: [],
      topCompetitorDomain: null,
    },
  });
};

const input = (fields: Partial<MethodologyInput> = {}): MethodologyInput => {
  return {
    surfaces: ['chatgpt', 'claude', 'codex'],
    askedModels: { chatgpt: ['openai/default-1'], claude: [] },
    defaults: {
      models: {
        chatgpt: 'openai/default-1',
        claude: 'anthropic/default-1',
        gemini: 'google/default-1',
        perplexity: 'perplexity/default-1',
      },
      chosenOn: '2026-11-10',
    },
    labels: {},
    sections: [{ visibility: visibility(true) }],
    ...fields,
  };
};

describe('methodology - buildMethodology()', () => {
  it('should state the models asked, what is not measured and what the numbers mean, for a run on the defaults', () => {
    expect(buildMethodology(input())).toEqual([
      "The API chat surfaces ask each provider's model through its API with web search, not through its consumer app. Models asked: ChatGPT (API): openai/default-1; Claude (API): no answer captured.",
      'Each is the gateway model closest to what the consumer product served its free tier by default when the models were chosen, on 2026-11-10. It is the nearest match, not the same product. Where a vendor names no model or no version for its free tier, it is the nearest model the gateway lists.',
      'Paid tiers of these products, and their thinking or reasoning modes, are not measured.',
      'A rate is a share of the planned answers: an answer that was planned and not captured counts as one in which the company was not mentioned or cited.',
      'Beside each rate, the approximate 95% interval (a Wilson score interval) describes answer-to-answer variation for these questions at the time of the audit. It is not a market share, not uncertainty about which questions buyers ask, and not a forecast. Where answers were not captured, the interval allows for either outcome in each of them.',
      'The interval assumes that repeated runs of one question are independent. Runs minutes apart can share a search index or a provider cache; if they return near-duplicate answers, the interval is too narrow.',
      "Figures from literally-aeo 0.4.0 or later are comparable with an earlier release's only as a disclosed change of collection method: the models the API chat surfaces ask changed with that release.",
    ]);
  });

  it('should name a surface asked of another model than its default, and a custom model with its own search', () => {
    const sentences = buildMethodology(
      input({
        surfaces: ['chatgpt', 'custom:grok'],
        askedModels: { chatgpt: ['openai/other-1'] },
        labels: { 'custom:grok': 'Grok 5 (acme/grok-5)' },
      }),
    );

    expect(sentences[1]).toContain(
      'Asked of another model than that default: ChatGPT (API).',
    );
    expect(sentences[3]).toBe(
      "Custom models (Grok 5 (acme/grok-5)) were chosen by this audit's author. Each is asked every question through the gateway's own web search tool, which is not the search its maker's product uses. The tool attaches no source list to an answer, so a custom model's citation rate counts only the links the model writes in its answer. They are scored on their own lines and are not part of the headline rates.",
    );
  });

  it("should say that Perplexity's two runs of a question are often one observation of a citation, only where its own model answered", () => {
    const repeated =
      'Perplexity (API) often lists the same sources in both runs of a question. Those two runs are then one observation of whether the company is cited, not two, and the interval of a citation rate that includes it does not allow for that.';
    const asked = (model: string) => {
      return buildMethodology(
        input({
          surfaces: ['chatgpt', 'perplexity'],
          askedModels: {
            chatgpt: ['openai/default-1'],
            perplexity: [model],
          },
        }),
      );
    };

    expect(asked('perplexity/default-1')).toContain(repeated);
    expect(asked('acme/model-1')).not.toContain(repeated);
    expect(buildMethodology(input())).not.toContain(repeated);
  });

  it('should say that the consumer apps are scraped products with no pinned model, what an answer and a citation are there, and that they are scored apart', () => {
    const sentences = buildMethodology(
      input({
        surfaces: ['chatgpt', 'chatgpt_app', 'google_ai_mode'],
        reportedModels: { chatgpt_app: ['gpt-6'] },
      }),
    );

    expect(sentences.slice(3, 7)).toEqual([
      "ChatGPT (app) and AI Mode are measured in the consumer product itself, not through an API: DataForSEO scrapes each answer from the product's web page. Nothing pins the model that answers, and the vendor does not document whether its session is logged in, so which tier of the product answered is not known.",
      'An answer from ChatGPT (app) is the text and the tables of the page; everything else on it, such as images, shopping results and advertisements, is left out. The scraper reported the model as gpt-6. A citation there counts the sources the scraper lists as cited or relied on, and the links in the answer.',
      "An answer from AI Mode leaves out the links that lead back into Google's own search and shopping results: they are not sources, and are not counted as citations.",
      'The consumer apps are scored as a group of their own, apart from the headline rates of the API chat surfaces and AI Overview.',
    ]);
  });

  it('should keep the sentence a sentence whatever model names a scraper reported', () => {
    // A scraper's model name is whatever its page showed, up to 200
    // characters each.
    const reported = Array.from(
      { length: 12 },
      (_, index) => `${index}${'m'.repeat(199)}`,
    );
    const sentences = buildMethodology(
      input({
        surfaces: ['chatgpt_app'],
        reportedModels: { chatgpt_app: reported },
      }),
    );

    expect(sentences[1]).toContain(
      `The scraper reported the model as ${reported.slice(0, 3).join(', ')} and 9 more.`,
    );
    // Every sentence fits the snapshot's own bound.
    expect(
      aeoSnapshotSchema.shape.meta.shape.methodology.safeParse(sentences)
        .success,
    ).toBe(true);
  });

  it('should name no model the scraper did not report, and say nothing of ChatGPT for a run that measured AI Mode alone', () => {
    const unreported = buildMethodology(
      input({ surfaces: ['chatgpt_app'], reportedModels: {} }),
    );
    const aiModeOnly = buildMethodology(
      input({ surfaces: ['google_ai_mode'] }),
    );

    expect(unreported[0]).toMatch(
      /^ChatGPT \(app\) is measured in the consumer product/,
    );
    expect(unreported.join(' ')).not.toContain('The scraper reported');
    expect(aiModeOnly[0]).toMatch(
      /^AI Mode is measured in the consumer product/,
    );
    expect(aiModeOnly.join(' ')).not.toContain('ChatGPT');
    // No API chat surface was planned: nothing is said of their models.
    expect(aiModeOnly.join(' ')).not.toContain('API chat surfaces ask');
  });

  it('should say nothing of API chat models or intervals a run does not have', () => {
    const sentences = buildMethodology(
      input({
        surfaces: ['codex'],
        sections: [{ visibility: visibility(false) }],
      }),
    );

    expect(sentences).toEqual([
      'A rate is a share of the planned answers: an answer that was planned and not captured counts as one in which the company was not mentioned or cited.',
    ]);
  });
});
