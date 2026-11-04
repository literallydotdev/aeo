import { describe, expect, it, vi } from 'vitest';
import { createMemoryModelAccounting } from '../models/accounting';
import { testModelProfileFixture } from '../models/profile-fixture';
import type { StructuredTransport } from '../models/structured';
import { contentHash } from '../stores/content-hash';
import { requireDefined } from '../__fixtures__/require-defined';
import type { SavedAnswer } from './schema';
import {
  extractClaimCandidates,
  claimExtractionSchema,
  type ClaimExtractionDiagnostic,
  type ValidatedExtractionBatch,
} from './extract';

const text = 'Private captured answer: Deno supports TypeScript.';

const answer = (index = 0, value = text): SavedAnswer => {
  return {
    id: `answer-${index}`,
    runId: 'run-1',
    section: 'runtime',
    promptId: 'p1',
    surface: 'chatgpt',
    runIndex: index,
    capturedAt: '2026-09-09T00:00:00.000Z',
    text: value,
    digest: contentHash(value),
  };
};

const claim = (answerId: string, quote: string) => {
  return {
    answerId,
    quote,
    proposition: 'Deno supports TypeScript.',
    scope: {
      product: 'Deno',
      generation: null,
      version: null,
      applicableAt: null,
    },
    category: 'capability',
    inAuditedProductScope: true,
  };
};

const accounting = () => {
  return createMemoryModelAccounting({
    maxUsd: 100,
    maxTokens: 1_000_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });
};

type ExtractionResult = Awaited<ReturnType<typeof extractClaimCandidates>>;

const firstOccurrence = (result: ExtractionResult) => {
  const candidate = requireDefined(result.candidates[0], 'first candidate');

  return requireDefined(candidate.occurrences[0], 'first occurrence');
};

describe('extract - extractClaimCandidates() diagnostics', () => {
  it.each([
    {
      reason: 'unknown_answer_id',
      answer: answer(),
      claim: claim('invented-answer', text),
    },
    {
      reason: 'quote_not_found',
      answer: answer(),
      claim: claim('answer-0', 'Private captured answer: Deno supports TS.'),
    },
    {
      reason: 'quote_ambiguous',
      answer: answer(0, `${text}\n${text}`),
      claim: claim('answer-0', text),
    },
    {
      reason: 'quote_not_found',
      answer: answer(0, `${'x'.repeat(16_000)}${text}`),
      claim: claim('answer-0', text),
    },
    {
      reason: 'quote_ambiguous',
      answer: answer(0, `${text}${'x'.repeat(16_000)}${text}`),
      claim: claim('answer-0', text),
    },
  ])(
    'should retain untrusted output for $reason and drop the claim, not the run',
    async (fixture) => {
      const ledger = accounting();
      const diagnostics: ClaimExtractionDiagnostic[] = [];
      const commitCandidates = vi.fn<(result: ExtractionResult) => void>();
      const fromCache = fixture.reason === 'unknown_answer_id';
      const transport: StructuredTransport = (input) => {
        return Promise.resolve({
          output: input.schema.parse({ claims: [fixture.claim] }),
          usage: {},
        });
      };
      const storedBatch = (key: string): ValidatedExtractionBatch => {
        return {
          kind: 'validated_extraction_batch',
          version: 1,
          key,
          callId: 'stored-call',
          output: claimExtractionSchema.parse({ claims: [fixture.claim] }),
        };
      };

      const run = extractClaimCandidates({
        answers: [fixture.answer],
        product: 'Deno',
        role: testModelProfileFixture().roles.perception,
        accounting: ledger,
        transport,
        batchCache: fromCache
          ? {
              get: (key) => Promise.resolve(storedBatch(key)),
              put: () => Promise.resolve(),
            }
          : undefined,
        onDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);

          return Promise.resolve();
        },
      }).then(commitCandidates);

      if (fromCache) {
        // A cached batch is stored data the host proved once. A quote that no
        // longer locates means the entry is corrupt, which is refused rather
        // than quietly pruned.
        const error = (await run.catch((caught: unknown) => caught)) as Error;

        expect(error.message).toContain(
          `Extraction ${fixture.reason} (batchIndex=0, callId=`,
        );
        expect(error.message).not.toContain(fixture.claim.quote);
        expect(error.message).not.toContain(fixture.claim.answerId);
        expect(commitCandidates).not.toHaveBeenCalled();
      } else {
        // A model's unusable claim is dropped, not the run. The guarantee is
        // that no claim reaches a reader without its answer's own words, and
        // dropping it keeps that exactly as well as failing the audit did.
        // The drop is visible: the coverage counts it against its answer.
        await run;

        expect(commitCandidates).toHaveBeenCalled();
        expect(commitCandidates.mock.calls[0]?.[0]).toMatchObject({
          candidates: [],
          coverage: {
            droppedClaims: 1,
            droppedClaimsByAnswer: [{ answerId: fixture.answer.id, claims: 1 }],
          },
        });
      }

      // A generated slip is regenerated up to the attempt bound, each slip
      // retained; a corrupted cache entry is refused at once.
      expect(diagnostics).toHaveLength(fromCache ? 1 : 3);
      expect(Object.keys(ledger.state.calls)).toHaveLength(fromCache ? 0 : 3);
      expect(diagnostics.at(-1)).toMatchObject({
        kind: 'untrusted_extraction_diagnostic',
        version: 1,
        trusted: false,
        reason: fixture.reason,
        batchIndex: 0,
        batchStart: 0,
        claimIndex: 0,
        callId: fromCache
          ? 'stored-call'
          : Object.keys(ledger.state.calls).at(-1),
        rawOutput: { claims: [fixture.claim] },
        suppliedAnswers: [
          {
            answerId: fixture.answer.id,
            answerDigest: fixture.answer.digest,
            suppliedTextDigest: contentHash(
              fixture.answer.text.slice(0, 16_000),
            ),
            suppliedChars: Math.min(fixture.answer.text.length, 16_000),
          },
        ],
      });
    },
  );

  it('should identify a corrupted cached later batch without accepting references from an earlier batch', async () => {
    const answers = Array.from({ length: 6 }, (_, index) =>
      answer(index, `${text} Answer ${index}.`),
    );
    const diagnostics: ClaimExtractionDiagnostic[] = [];
    let reads = 0;
    const transport = vi.fn(() =>
      Promise.reject(new Error('Unexpected model call for a cached batch.')),
    );

    const result = extractClaimCandidates({
      answers,
      product: 'Deno',
      role: testModelProfileFixture().roles.perception,
      accounting: accounting(),
      transport,
      batchCache: {
        get: (key) => {
          const selected = requireDefined(
            answers[reads === 0 ? 0 : 1],
            'cached answer',
          );

          reads += 1;

          return Promise.resolve({
            kind: 'validated_extraction_batch',
            version: 1,
            key,
            callId: 'stored-call',
            output: claimExtractionSchema.parse({
              claims: [claim(selected.id, selected.text)],
            }),
          });
        },
        put: () => Promise.resolve(),
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);

        return Promise.resolve();
      },
    });

    await expect(result).rejects.toThrow(
      'unknown_answer_id (batchIndex=1, callId=',
    );
    expect(reads).toBe(2);
    expect(transport).not.toHaveBeenCalled();

    const [diagnostic] = diagnostics;

    expect(diagnostic?.batchStart).toBe(3);
    expect(diagnostic?.suppliedAnswers.map((item) => item.answerId)).toEqual([
      'answer-3',
      'answer-4',
      'answer-5',
    ]);
  });

  it('should return exact validated candidates without creating a diagnostic on success', async () => {
    const onDiagnostic = vi.fn();
    const transport: StructuredTransport = (input) => {
      return Promise.resolve({
        output: input.schema.parse({ claims: [claim('answer-0', text)] }),
        usage: {},
      });
    };

    const result = await extractClaimCandidates({
      answers: [answer()],
      product: 'Deno',
      role: testModelProfileFixture().roles.perception,
      accounting: accounting(),
      transport,
      onDiagnostic,
    });

    expect(firstOccurrence(result)).toMatchObject({
      start: 0,
      end: text.length,
      quote: text,
    });
    expect(result.coverage.droppedClaims).toBeUndefined();
    expect(result.coverage.droppedClaimsByAnswer).toBeUndefined();
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('should store the answer’s own passage when the model quoted through dropped markdown, and cache that form', async () => {
    const onDiagnostic = vi.fn();
    const put =
      vi.fn<(key: string, batch: ValidatedExtractionBatch) => Promise<void>>();
    const formatted =
      'Private captured answer: **Deno** supports *TypeScript*.';
    const transport: StructuredTransport = (input) => {
      return Promise.resolve({
        output: input.schema.parse({ claims: [claim('answer-0', text)] }),
        usage: {},
      });
    };

    const result = await extractClaimCandidates({
      answers: [answer(0, formatted)],
      product: 'Deno',
      role: testModelProfileFixture().roles.perception,
      accounting: accounting(),
      transport,
      batchCache: { get: () => Promise.resolve(null), put },
      onDiagnostic,
    });

    expect(firstOccurrence(result)).toMatchObject({
      start: 0,
      end: formatted.length,
      quote: formatted,
    });
    expect(put.mock.calls[0]?.[1].output.claims[0]?.quote).toBe(formatted);
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('should regenerate once after a quoting slip and keep the verbatim retry', async () => {
    const diagnostics: ClaimExtractionDiagnostic[] = [];
    let calls = 0;
    const transport: StructuredTransport = (input) => {
      const quote = calls === 0 ? 'Deno supports TS.' : text;

      calls += 1;

      return Promise.resolve({
        output: input.schema.parse({ claims: [claim('answer-0', quote)] }),
        usage: {},
      });
    };

    const result = await extractClaimCandidates({
      answers: [answer()],
      product: 'Deno',
      role: testModelProfileFixture().roles.perception,
      accounting: accounting(),
      transport,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);

        return Promise.resolve();
      },
    });

    expect(calls).toBe(2);
    expect(diagnostics.map((entry) => entry.reason)).toEqual([
      'quote_not_found',
    ]);
    expect(firstOccurrence(result).quote).toBe(text);
  });
});
