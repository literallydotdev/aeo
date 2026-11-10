import { describe, expect, it } from 'vitest';
import { auditFileSchema, toAuditConfig } from '../engine/audit-file';
import { exampleAuditFile } from '../engine/templates';
import { aeoSnapshotSchema } from '../schema';
import { buildFactCatalog } from './facts';

const config = toAuditConfig(auditFileSchema.parse(exampleAuditFile));
const [section] = config.sections;

if (!section) {
  throw new Error('The example audit has no section.');
}

const snapshotWith = (summary: Record<string, unknown>, labels = {}) => {
  return aeoSnapshotSchema.parse({
    version: 2,
    reportKey: config.reportKey,
    brand: config.brand,
    competitors: config.competitors,
    sections: [
      {
        key: section.key,
        visibility: {
          prompts: [],
          surfaces: [],
          matrix: [],
          summary: {
            prospectShareOfVoice: 0.25,
            prospectCitationRate: 0,
            agentShareOfVoice: null,
            agentCitationRate: null,
            byModel: {},
            byCompetitor: [],
            topCompetitorDomain: null,
            ...summary,
          },
        },
      },
    ],
    meta: {
      generatedAt: '2026-11-10T00:00:00.000Z',
      promptCount: 0,
      probeCount: 0,
      partialFailures: [],
      surfaceLabels: labels,
    },
  });
};

const intervalFactsOf = (summary: Record<string, unknown>, labels = {}) => {
  return buildFactCatalog({
    snapshot: snapshotWith(summary, labels),
    config,
    runId: 'run-1',
  }).facts.filter(({ factId }) => factId.startsWith('interval:'));
};

describe('facts - buildFactCatalog() interval facts', () => {
  it('should state each rate with evidence as a range that contains its interval, with its counts', () => {
    const [fact] = intervalFactsOf({
      prospectShareOfVoiceEvidence: {
        count: 2,
        captured: 8,
        planned: 8,
        low: 0.071494,
        high: 0.591181,
      },
    });

    expect(fact).toMatchObject({
      kind: 'measurement',
      factId: `interval:${section.key}:chat:mentions`,
      metric: 'mentions_interval',
      numerator: 2,
      denominator: 8,
      unit: 'planned_answers',
    });
    // 7.1494% and 59.1181%, rounded outward.
    expect(fact?.sentence).toContain(
      `chat and search assistants together mentioned ${config.brand.name} in between 7% and 60% of planned answers (approximate 95% interval, from 2 of 8).`,
    );
    expect(fact?.sentence).toContain(
      'answer-to-answer variation for these questions at the time of the audit, not market share',
    );
    expect(fact?.sentence).not.toContain('not captured');
  });

  it('should say how many planned answers were missing, and name a labelled surface by its label', () => {
    const facts = intervalFactsOf(
      {
        byModel: {
          'custom:grok': {
            shareOfVoice: 0.25,
            citationRate: 0,
            shareOfVoiceEvidence: {
              count: 1,
              captured: 2,
              planned: 4,
              low: 0.045587,
              high: 0.964413,
            },
          },
        },
      },
      { 'custom:grok': 'Grok 5 (acme/grok-5)' },
    );

    expect(facts.map(({ factId }) => factId)).toEqual([
      `interval:${section.key}:custom:grok:mentions`,
    ]);
    expect(facts[0]?.sentence).toContain('Grok 5 (acme/grok-5) mentioned');
    expect(facts[0]?.sentence).toContain(
      'between 4% and 97% of planned answers',
    );
    expect(facts[0]?.sentence).toContain(
      '2 planned answers were not captured, and the interval allows for either outcome in each.',
    );
  });

  it('should add no interval fact to a snapshot without evidence, as before 0.4.0', () => {
    expect(
      intervalFactsOf({
        byModel: { chatgpt: { shareOfVoice: 0.25, citationRate: 0 } },
      }),
    ).toEqual([]);
  });

  it('should keep a bound of exactly 7% at 7%', () => {
    const [fact] = intervalFactsOf({
      agentShareOfVoiceEvidence: {
        count: 1,
        captured: 4,
        planned: 4,
        low: 0.07,
        high: 0.93,
      },
    });

    expect(fact?.sentence).toContain('between 7% and 93% of planned answers');
  });
});
