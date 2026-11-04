import { assert, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import configFixture from '../__fixtures__/replay/literally-2026-q3/config.json';
import snapshotFixture from '../__fixtures__/replay/literally-2026-q3/snapshot.json';
import { aeoAuditConfigSchema, aeoSnapshotSchema } from '../schema';
import { createGroundingBundle } from '../grounding/validation';
import { contentHash } from '../stores/content-hash';
import { structuredCallReservation } from '../models/structured';
import { testModelProfileFixture } from '../models/profile-fixture';
import {
  groundingFixture,
  measurementGroundingFixture,
} from './__fixtures__/grounding';
import { buildFactCatalog, projectWriterFactCatalog } from './facts';
import { validateAgentCopy, type RecommendationInput } from './copy-validation';

describe('facts - projectWriterFactCatalog()', () => {
  it('should keep repeated source passages outside generation while preserving scoped facts and full premise verification', async () => {
    const config = aeoAuditConfigSchema.parse(configFixture);
    const snapshot = aeoSnapshotSchema.parse({
      ...snapshotFixture,
      meta: { ...snapshotFixture.meta, runId: 'run-1' },
    });
    const base = measurementGroundingFixture(config.reportKey, 'run-1');
    const [source] = groundingFixture().sources;
    const text =
      'Legacy edition requires compatibility mode for middleware. '.repeat(250);

    assert(source);

    source.documentDigest = contentHash(text);
    source.retainedDigest = contentHash([text]);
    source.passages = [{ id: 'passage-1', text, digest: contentHash(text) }];
    const bundle = createGroundingBundle({
      ...base,
      sources: [source],
      facts: Array.from({ length: 40 }, (_, index) => ({
        id: `compatibility-${index}`,
        proposition: `Middleware feature ${index} requires compatibility mode.`,
        scope: {
          product: 'Example',
          generation: 'Legacy edition',
          version: '2',
          applicableAt: '2026-09-08T12:00:00.000Z',
        },
        references: [{ sourceId: source.id, passageId: 'passage-1' }],
        status: 'supported' as const,
        reason: 'The saved passage explicitly requires compatibility mode.',
      })),
    });

    const catalog = buildFactCatalog({
      snapshot,
      config,
      runId: 'run-1',
      grounding: bundle,
    });
    const originalDigest = contentHash(catalog);

    const writer = projectWriterFactCatalog(catalog);

    const reservation = (value: unknown) => {
      return structuredCallReservation({
        role: testModelProfileFixture().roles.copy,
        schema: z.object({ output: z.string() }),
        prompt: JSON.stringify(value),
      });
    };
    const writerFact = writer.facts.find(
      (fact) => fact.factId === 'product:compatibility-0',
    );

    expect(() => reservation(catalog)).toThrow('model_input_limit');
    expect(reservation(writer).inputTokens).toBeLessThan(80_000);
    expect(writer.facts.map((fact) => fact.factId)).toEqual(
      catalog.facts.map((fact) => fact.factId),
    );
    expect(writerFact?.sentence).toContain(
      'Example, Legacy edition, 2, as of 2026-09-08T12:00:00.000Z',
    );
    expect(writerFact?.sentence).toContain(
      'Middleware feature 0 requires compatibility mode.',
    );
    expect(JSON.stringify(writer)).not.toContain(text);
    expect(contentHash(catalog)).toBe(originalDigest);

    const verifier = vi.fn((recommendations: RecommendationInput[]) => {
      const fact = recommendations
        .flatMap((recommendation) => recommendation.facts)
        .find((entry) => entry.factId === 'product:compatibility-0');

      expect(fact?.kind).toBe('product_fact');

      if (fact?.kind !== 'product_fact') {
        throw new Error('Expected a complete product fact.');
      }

      expect(fact.sources[0]?.passages[0]?.text).toBe(text);

      return Promise.resolve({
        valid: true,
        errors: [],
        model: testModelProfileFixture().roles.premiseVerifier.model,
      });
    });

    const result = await validateAgentCopy({
      config,
      configVersion: 1,
      snapshot,
      runId: 'run-1',
      grounding: bundle,
      verifier,
      verifierProfile: testModelProfileFixture().roles.premiseVerifier,
      draft: {
        intro: [
          {
            kind: 'recommendation',
            text: 'Consider a guide to compatibility mode.',
            intendedAction: 'Create a guide to the compatibility requirement.',
            basisFactIds: ['product:compatibility-0'],
            premises: [
              {
                proposition:
                  'Middleware feature 0 requires compatibility mode.',
                basisFactIds: ['product:compatibility-0'],
              },
            ],
          },
        ],
        sections: Object.fromEntries(
          config.sections.map(({ key }) => [
            key,
            {
              subtitle: [{ kind: 'fact', factId: 'aggregate:captured' }],
            },
          ]),
        ),
        confidence: 0.9,
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(verifier).toHaveBeenCalledOnce();
  });
});
