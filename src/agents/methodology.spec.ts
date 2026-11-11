import { describe, expect, it } from 'vitest';
import { aeoVisibilitySchema } from '../report/core/schema';
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
