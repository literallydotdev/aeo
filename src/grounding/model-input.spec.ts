import { describe, expect, it } from 'vitest';
import { createMemoryModelAccounting } from '../models/accounting';
import { testModelProfileFixture } from '../models/profile-fixture';
import {
  structuredCallReservation,
  type StructuredTransport,
} from '../models/structured';
import { contentHash } from '../stores/content-hash';
import { structuredWireSchema } from '../models/wire-schema';
import { requireDefined } from '../__fixtures__/require-defined';
import {
  groundingEvaluationFixtures,
  materializeEvaluationFixture,
} from './evaluation-fixtures';
import { extractSourceDocument } from './fetch';
import { createGatewayGroundingModel } from './model';
import type { GroundingBundle } from './schema';
import { createGroundingBundle } from './validation';

type PromptPassage = {
  id: string;
  text: string;
  truncated: boolean;
  omitted?: boolean;
};

type PromptView = {
  candidates: { id: string; proposition: string; scope: unknown }[];
  sources: { id: string; passages: PromptPassage[] }[];
  inputCoverage?: {
    projectionVersion: number;
    retainedPassages: number;
    truncatedPassages: number;
    omittedPassages: number;
  };
};

const parsePrompt = (prompt: string) => {
  return JSON.parse(prompt) as PromptView;
};

const firstFixture = () => {
  return requireDefined(groundingEvaluationFixtures[0], 'first fixture');
};

const accounting = () => {
  return createMemoryModelAccounting({
    maxUsd: 100,
    maxTokens: 10_000_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });
};

/** Assess every claim the request carried. These fixtures are about the
 * input projection, so each adjudication must be answered completely —
 * an incomplete answer is asked again and would change the dispatch count. */
const coverAll = (prompt: string) => {
  return parsePrompt(prompt).candidates.map((candidate) => ({
    claimId: candidate.id,
    verdict: 'unresolved' as const,
    references: [],
    reason: 'not_in_sources' as const,
    explanation: 'An input-projection fixture.',
  }));
};

// This is the original small-payload projection, retained to prove compatibility
// with the exact frozen-evidence evaluation inputs (not their expected verdicts).
const originalSmallPrompt = (bundle: GroundingBundle) => {
  return JSON.stringify({
    reviewAsOf: bundle.reviewAsOf,
    sourceBundleDigest: bundle.sourceBundleDigest,
    candidates: bundle.candidates
      .filter((candidate) => candidate.disposition === 'selected')
      .map((candidate) => ({
        ...candidate,
        occurrences: candidate.occurrences.slice(0, 2).map((occurrence) => ({
          ...occurrence,
          quote: occurrence.quote.slice(0, 2000),
          quoteTruncated: occurrence.quote.length > 2000,
        })),
      })),
    sources: bundle.sources.map((source) => ({
      id: source.id,
      finalUrl: source.finalUrl,
      provenance: source.provenance,
      sourceDate: source.sourceDate,
      fetchedAt: source.fetchedAt,
      passages: source.passages.map((passage) => ({
        id: passage.id,
        text: passage.text,
        truncated: source.truncated,
      })),
    })),
  });
};

describe('model - adjudication input projection', () => {
  it('should preserve every frozen evaluation prompt byte-for-byte when it fits', async () => {
    const profile = testModelProfileFixture();

    for (const fixture of groundingEvaluationFixtures) {
      const { bundle } = materializeEvaluationFixture(fixture);
      const transport: StructuredTransport = (input) => {
        expect(input.prompt, fixture.id).toBe(originalSmallPrompt(bundle));
        expect(input.system).toContain(
          'A null scope.generation or scope.version',
        );

        return Promise.resolve({
          output: input.schema.parse({ assessments: coverAll(input.prompt) }),
          usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 },
        });
      };
      const model = createGatewayGroundingModel({
        researchRole: profile.roles.research,
        adjudicationRole: profile.roles.adjudication,
        accounting: accounting(),
        transport,
      });

      expect(model.adjudication.inputProjectionVersion).toBe(2);

      await model.adjudicate(bundle, new AbortController().signal);
    }
  });

  it.each([2, 6])(
    'should bound %s large escaped Unicode sources by the actual wire reservation, preserving claims and retained sources',
    async (sourceCount) => {
      const profile = testModelProfileFixture();
      const { bundle: initial } = materializeEvaluationFixture(firstFixture());
      const initialClaim = requireDefined(
        initial.candidates[0],
        'initial claim',
      );
      const sources = Array.from({ length: sourceCount }, (_, index) => {
        const url = `https://docs.example.com/source-${index}`;

        return extractSourceDocument({
          requestedUrl: url,
          finalUrl: url,
          contentType: 'text/plain',
          fetchedAt: initial.reviewAsOf,
          body: '📦 Unicode 文档 and "quoted values".\nA second line with \\ escapes and U+FFFD: �.\n'.repeat(
            500,
          ),
        }).source;
      });
      const candidates = Array.from({ length: 40 }, (_, index) => ({
        ...initialClaim,
        id: `claim_${contentHash({ index }).slice(0, 32)}`,
        priority: index,
        proposition: `Claim ${index}: ${'A scoped proposition with an explicit version and conditions. '.repeat(
          7,
        )}`,
        scope: {
          ...initialClaim.scope,
          generation: index % 2 ? 'Classic' : null,
          version: `version-${index}`,
        },
      }));
      const bundle = createGroundingBundle({
        ...initial,
        candidates,
        sources,
        coverage: { ...initial.coverage, selectedCandidates: 40 },
      });
      const originalDigest = contentHash(bundle);
      let dispatched = 0;
      let expectedPrompt: string | undefined;
      const transport: StructuredTransport = (input) => {
        dispatched += 1;

        const wire = structuredWireSchema(input.schema).wire as {
          properties: {
            assessments: {
              items: {
                anyOf: { properties: { claimId: { enum: string[] } } }[];
              };
            };
          };
        };

        for (const branch of wire.properties.assessments.items.anyOf) {
          expect(branch.properties.claimId.enum).toEqual(
            candidates.map(({ id }) => id),
          );
        }

        const reservation = structuredCallReservation(input);

        expect(reservation.inputTokens).toBeLessThanOrEqual(
          profile.roles.adjudication.maxInputTokens,
        );

        const visible = parsePrompt(input.prompt);

        expect(
          visible.candidates.map((candidate) => ({
            id: candidate.id,
            proposition: candidate.proposition,
            scope: candidate.scope,
          })),
        ).toEqual(
          candidates.map(({ id, proposition, scope }) => ({
            id,
            proposition,
            scope,
          })),
        );
        const inputCoverage = requireDefined(
          visible.inputCoverage,
          'input coverage',
        );

        expect(inputCoverage.projectionVersion).toBe(2);
        expect(inputCoverage.truncatedPassages).toBeGreaterThan(0);
        expect(inputCoverage.retainedPassages).toBe(
          sources.reduce((count, source) => count + source.passages.length, 0),
        );

        for (const [sourceIndex, source] of visible.sources.entries()) {
          const originalSource = requireDefined(
            sources[sourceIndex],
            'original source',
          );

          expect(source.id).toBe(originalSource.id);

          for (const [passageIndex, passage] of source.passages.entries()) {
            const original = requireDefined(
              originalSource.passages[passageIndex],
              'original passage',
            );

            expect(passage.id).toBe(original.id);
            expect(original.text.startsWith(passage.text)).toBe(true);
            expect(passage.truncated).toBe(true);
            expect(Buffer.from(passage.text).toString('utf8')).toBe(
              passage.text,
            );
          }
        }

        // Identical bounded inputs must make the same deterministic projection.
        if (expectedPrompt) {
          expect(input.prompt).toBe(expectedPrompt);
        }

        expectedPrompt = input.prompt;

        return Promise.resolve({
          output: input.schema.parse({ assessments: coverAll(input.prompt) }),
          usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 },
        });
      };
      const model = createGatewayGroundingModel({
        researchRole: profile.roles.research,
        adjudicationRole: profile.roles.adjudication,
        accounting: accounting(),
        transport,
      });

      await model.adjudicate(bundle, new AbortController().signal);
      await model.adjudicate(bundle, new AbortController().signal);

      expect(dispatched).toBe(2);
      expect(contentHash(bundle)).toBe(originalDigest);
    },
  );

  it('should fail before reserving or dispatching when required claim data alone exceeds the pinned input cap', async () => {
    const profile = testModelProfileFixture();
    const { bundle } = materializeEvaluationFixture(firstFixture());
    const ledger = accounting();
    let dispatched = false;
    const transport: StructuredTransport = (input) => {
      dispatched = true;

      return Promise.resolve({
        output: input.schema.parse({ assessments: coverAll(input.prompt) }),
        usage: {},
      });
    };
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: { ...profile.roles.adjudication, maxInputTokens: 100 },
      accounting: ledger,
      transport,
    });

    const result = model.adjudicate(bundle, new AbortController().signal);

    await expect(result).rejects.toThrow(
      'selected claims and source identifiers exceed adjudication input capacity',
    );
    expect(dispatched).toBe(false);
    expect(Object.keys(ledger.state.calls)).toHaveLength(0);
  });

  it('should label every omitted passage and retain its ID when only metadata fits', async () => {
    const profile = testModelProfileFixture();
    const { bundle } = materializeEvaluationFixture(firstFixture());
    const retainedPassages = bundle.sources.reduce(
      (sum, source) => sum + source.passages.length,
      0,
    );

    expect(retainedPassages).toBeGreaterThan(0);

    let metadataLimit = 0;
    const transport: StructuredTransport = (input) => {
      const view = parsePrompt(input.prompt);

      if (!metadataLimit) {
        for (const source of view.sources) {
          for (const passage of source.passages) {
            Object.assign(passage, {
              text: '',
              truncated: true,
              omitted: true,
            });
          }
        }

        view.inputCoverage = {
          projectionVersion: 2,
          retainedPassages,
          truncatedPassages: retainedPassages,
          omittedPassages: retainedPassages,
        };
        metadataLimit = structuredCallReservation({
          ...input,
          prompt: JSON.stringify(view),
        }).inputTokens;
      } else {
        expect(view.inputCoverage).toEqual({
          projectionVersion: 2,
          retainedPassages,
          truncatedPassages: retainedPassages,
          omittedPassages: retainedPassages,
        });
        expect(view.sources.flatMap((source) => source.passages)).toEqual(
          bundle.sources.flatMap((source) =>
            source.passages.map((passage) => ({
              id: passage.id,
              text: '',
              truncated: true,
              omitted: true,
            })),
          ),
        );
        expect(structuredCallReservation(input).inputTokens).toBe(
          metadataLimit,
        );
      }

      return Promise.resolve({
        output: input.schema.parse({ assessments: coverAll(input.prompt) }),
        usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 },
      });
    };
    const common = {
      researchRole: profile.roles.research,
      accounting: accounting(),
      transport,
    };

    await createGatewayGroundingModel({
      ...common,
      adjudicationRole: profile.roles.adjudication,
    }).adjudicate(bundle, new AbortController().signal);
    await createGatewayGroundingModel({
      ...common,
      adjudicationRole: {
        ...profile.roles.adjudication,
        maxInputTokens: metadataLimit,
      },
    }).adjudicate(bundle, new AbortController().signal);
  });
});
