import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryModelAccounting,
  ModelBudgetError,
} from '../models/accounting';
import { testModelProfileFixture } from '../models/profile-fixture';
import {
  StructuredOutputMissingError,
  type StructuredTransport,
} from '../models/structured';
import { contentHash } from '../stores/content-hash';
import { requireDefined } from '../__fixtures__/require-defined';
import type { ClaimCandidate, SavedAnswer } from './schema';
import {
  extractClaimCandidates,
  type ClaimExtractionDiagnostic,
  type ValidatedExtractionBatch,
} from './extract';

// Level 1 tests for the claim-extraction unit: a mocked transport stands in
// for the gateway, and every assertion is about what a caller of
// extractClaimCandidates can observe (candidates, coverage, diagnostics,
// the cache and the ledger), never about how batches are scheduled.

const role = testModelProfileFixture().roles.perception;
const deadlineAt = '2099-01-01T00:00:00.000Z';

/** An answer shaped the way evaluation-fixtures materialises one: the digest
 * is the content hash of the exact text, which extraction re-checks. */
const savedAnswer = (index: number, text: string): SavedAnswer => {
  return {
    id: `answer-${index}`,
    runId: 'run-1',
    section: 'runtime',
    promptId: 'p1',
    surface: 'chatgpt',
    runIndex: index,
    capturedAt: '2026-09-09T00:00:00.000Z',
    text,
    digest: contentHash(text),
  };
};

const answers = (count: number): SavedAnswer[] => {
  return Array.from({ length: count }, (_, index) =>
    savedAnswer(index, `Deno claim ${index} has exact original punctuation.`),
  );
};

const claim = (answerId: string, quote: string, proposition = quote) => {
  return {
    answerId,
    quote,
    proposition,
    scope: {
      product: 'Deno',
      generation: null,
      version: null,
      applicableAt: null,
    },
    category: 'capability' as const,
    inAuditedProductScope: true,
  };
};

type SuppliedAnswer = { id: string; text: string };

/** The answers one call was sent, read back from its prompt. */
const suppliedAnswers = (prompt: string) => {
  const parsed = JSON.parse(prompt) as { answers: SuppliedAnswer[] };

  return parsed.answers;
};

/** The first answer one call was sent. */
const firstSuppliedAnswer = (prompt: string): SuppliedAnswer => {
  return requireDefined(suppliedAnswers(prompt)[0], 'first supplied answer');
};

/** One claim per supplied answer, quoting the whole answer. */
const coverAll = (prompt: string) => {
  return {
    claims: suppliedAnswers(prompt).map((answer) =>
      claim(answer.id, answer.text),
    ),
  };
};

const ledger = () => {
  return createMemoryModelAccounting({
    maxUsd: 100,
    maxTokens: 10_000_000,
    deadlineAt,
  });
};

const usage = { costUsd: 0.01, inputTokens: 10, outputTokens: 10 };

const covering: StructuredTransport = (input) => {
  return Promise.resolve({
    output: input.schema.parse(coverAll(input.prompt)),
    usage,
  });
};

const firstAnswerIds = (candidates: readonly ClaimCandidate[]) => {
  return candidates.map((entry) => entry.occurrences[0]?.answerId);
};

const memoryCache = () => {
  const entries = new Map<string, ValidatedExtractionBatch>();

  return {
    entries,
    get: vi.fn((key: string) => Promise.resolve(entries.get(key))),
    put: vi.fn((key: string, batch: ValidatedExtractionBatch) => {
      entries.set(key, batch);

      return Promise.resolve();
    }),
  };
};

describe('extract - extractClaimCandidates()', () => {
  it('should build one verified candidate per answer and reports complete coverage', async () => {
    const supplied = answers(4);
    const accounting = ledger();
    const batchCache = memoryCache();
    const onDiagnostic = vi.fn();

    const result = await extractClaimCandidates({
      answers: supplied,
      product: 'Deno',
      role,
      accounting,
      transport: covering,
      batchCache,
      onDiagnostic,
    });

    expect(result.coverage).toEqual({
      suppliedAnswers: 4,
      extractedAnswers: 4,
      truncatedAnswers: 0,
      extractionStopReason: 'complete',
    });
    expect(result.candidates).toHaveLength(4);

    for (const answer of supplied) {
      const candidate = result.candidates.find(
        (entry) => entry.occurrences[0]?.answerId === answer.id,
      );
      expect(candidate).toMatchObject({
        proposition: answer.text,
        disposition: 'selected',
        occurrences: [
          {
            answerId: answer.id,
            answerDigest: answer.digest,
            start: 0,
            end: answer.text.length,
            quote: answer.text,
          },
        ],
      });
    }

    // Four answers are two batches of three: each is paid once and stored once.
    expect(onDiagnostic).not.toHaveBeenCalled();
    expect(batchCache.put).toHaveBeenCalledTimes(2);
    for (const [key, batch] of batchCache.put.mock.calls) {
      expect(batch).toMatchObject({
        kind: 'validated_extraction_batch',
        version: 1,
        key,
      });
    }

    const calls = Object.values(accounting.state.calls);

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.usage?.costUsd === usage.costUsd)).toBe(
      true,
    );
  });

  it('should accept a batch whose claims cover only some of its answers without asking again', async () => {
    // Extraction asks for the claims in a set of answers, not for a count:
    // an answer that yields no material claim is a complete result, so a
    // batch with claims for a subset of its answers is kept as-is and every
    // supplied answer counts as extracted. There is no gap to re-ask for.
    let calls = 0;
    const partial: StructuredTransport = (input) => {
      calls += 1;

      const first = firstSuppliedAnswer(input.prompt);

      return Promise.resolve({
        output: input.schema.parse({ claims: [claim(first.id, first.text)] }),
        usage,
      });
    };

    const result = await extractClaimCandidates({
      answers: answers(3),
      product: 'Deno',
      role,
      accounting: ledger(),
      transport: partial,
    });

    expect(calls).toBe(1);
    expect(firstAnswerIds(result.candidates)).toEqual(['answer-0']);
    expect(result.coverage).toMatchObject({
      suppliedAnswers: 3,
      extractedAnswers: 3,
      extractionStopReason: 'complete',
    });
  });

  it('should refuse a provider answer naming an unknown answer id at the schema boundary and stops that batch only', async () => {
    // The batch schema enumerates exactly the answer ids that were sent, so
    // an unknown id is refused before the host ever sees the claim: the
    // streaming transport reports it as a schema miss, which classifies as a
    // provider gap for that batch. The other batch in the wave still lands
    // and no run-ending error is thrown.
    const supplied = answers(6);
    const accounting = ledger();
    const onDiagnostic = vi.fn();
    const transport: StructuredTransport = (input) => {
      const first = firstSuppliedAnswer(input.prompt);
      const invented = claim('invented-answer', first.text);

      expect(input.schema.safeParse({ claims: [invented] }).success).toBe(
        false,
      );

      if (first.id === 'answer-0') {
        throw new StructuredOutputMissingError(
          {
            text: JSON.stringify({ claims: [invented] }),
            usage: { ...usage, finishReason: 'stop' },
            issues: [{ path: 'claims.0.answerId', message: 'Invalid option' }],
          },
          {
            cause: new Error(
              'No object generated: response did not match schema.',
            ),
          },
        );
      }

      return Promise.resolve({
        output: input.schema.parse(coverAll(input.prompt)),
        usage,
      });
    };

    const result = await extractClaimCandidates({
      answers: supplied,
      product: 'Deno',
      role,
      accounting,
      transport,
      onDiagnostic,
    });

    expect(firstAnswerIds(result.candidates).sort()).toEqual([
      'answer-3',
      'answer-4',
      'answer-5',
    ]);
    expect(result.coverage).toMatchObject({
      suppliedAnswers: 6,
      extractedAnswers: 3,
      extractionStopReason: 'provider_unavailable',
    });
    // The refusal happens at the structured-output boundary, so it is not
    // an untrusted-extraction diagnostic; the billed miss is settled invalid.
    expect(onDiagnostic).not.toHaveBeenCalled();

    const calls = Object.values(accounting.state.calls);

    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => call.usage?.valid === false)).toHaveLength(1);
  });

  it('should drop a claim whose quotation is not in its answer, keeps the claims beside it, and records the loss per answer', async () => {
    const first = savedAnswer(0, 'Deno supports TypeScript natively.');
    const second = savedAnswer(
      1,
      'Deno ships a formatter. Deno ships a linter.',
    );
    const diagnostics: ClaimExtractionDiagnostic[] = [];
    const batchCache = memoryCache();
    let calls = 0;
    const transport: StructuredTransport = (input) => {
      calls += 1;

      return Promise.resolve({
        output: input.schema.parse({
          claims: [
            claim(first.id, first.text),
            claim(second.id, 'Deno ships a bundler.'),
            claim(second.id, 'Deno ships a formatter.'),
          ],
        }),
        usage,
      });
    };

    const result = await extractClaimCandidates({
      answers: [first, second],
      product: 'Deno',
      role,
      accounting: ledger(),
      transport,
      batchCache,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);

        return Promise.resolve();
      },
    });

    // The slip is regenerated up to the bound, each attempt retained as an
    // untrusted diagnostic, before the one claim is dropped.
    expect(calls).toBe(3);
    expect(
      diagnostics.map((entry) => [entry.reason, entry.claimIndex]),
    ).toEqual([
      ['quote_not_found', 1],
      ['quote_not_found', 1],
      ['quote_not_found', 1],
    ]);
    expect(
      result.candidates.map((entry) => entry.occurrences[0]?.quote).sort(),
    ).toEqual([
      'Deno ships a formatter.',
      'Deno supports TypeScript natively.',
    ]);
    expect(result.coverage).toEqual({
      suppliedAnswers: 2,
      extractedAnswers: 2,
      truncatedAnswers: 0,
      extractionStopReason: 'complete',
      droppedClaims: 1,
      droppedClaimsByAnswer: [{ answerId: second.id, claims: 1 }],
    });
    // A pruned batch is this run's best effort, not a settled result.
    expect(batchCache.put).not.toHaveBeenCalled();
  });

  it('should reuse a validated batch from the cache instead of asking the model again', async () => {
    const supplied = answers(3);
    const batchCache = memoryCache();
    const first = await extractClaimCandidates({
      answers: supplied,
      product: 'Deno',
      role,
      accounting: ledger(),
      transport: covering,
      batchCache,
    });

    expect(batchCache.put).toHaveBeenCalledTimes(1);

    const accounting = ledger();
    const mustNotDispatch = vi.fn(() =>
      Promise.reject(new Error('Unexpected model call for a validated batch.')),
    );
    const onProgress = vi.fn();

    const second = await extractClaimCandidates({
      answers: supplied,
      product: 'Deno',
      role,
      accounting,
      transport: mustNotDispatch,
      batchCache,
      onProgress,
    });

    expect(second).toEqual(first);
    expect(mustNotDispatch).not.toHaveBeenCalled();
    expect(batchCache.get).toHaveBeenLastCalledWith(
      batchCache.put.mock.calls[0]?.[0],
    );
    expect(batchCache.put).toHaveBeenCalledTimes(1);
    expect(Object.keys(accounting.state.calls)).toHaveLength(0);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({
      batchIndex: 0,
      completedBatches: 1,
      totalBatches: 1,
      cached: true,
    });
  });

  describe('transport failure classification', () => {
    // Six answers are one wave of two batches; the batch holding answer-0
    // fails and the other succeeds, so the outcome shows what one failure
    // costs the rest of the wave.
    const failingOn = (error: Error): StructuredTransport => {
      return (input) => {
        if (firstSuppliedAnswer(input.prompt).id === 'answer-0') {
          return Promise.reject(error);
        }

        return covering(input);
      };
    };

    it.each([
      [
        'a transient provider error',
        Object.assign(new Error('502 Bad Gateway'), { statusCode: 502 }),
        'provider_unavailable',
      ],
      [
        'an exhausted budget',
        new ModelBudgetError('Model budget exhausted', 'exhausted'),
        'budget_exhausted',
      ],
      [
        'a reached deadline',
        new ModelBudgetError('Model budget deadline reached', 'deadline'),
        'budget_exhausted',
      ],
    ] as const)(
      'should record %s as a stop reason for that batch and keep the other batch',
      async (_name, error, extractionStopReason) => {
        const accounting = ledger();

        const result = await extractClaimCandidates({
          answers: answers(6),
          product: 'Deno',
          role,
          accounting,
          transport: failingOn(error),
        });

        expect(firstAnswerIds(result.candidates).sort()).toEqual([
          'answer-3',
          'answer-4',
          'answer-5',
        ]);
        expect(result.coverage).toMatchObject({
          suppliedAnswers: 6,
          extractedAnswers: 3,
          extractionStopReason,
        });
        // An unknown failure does not prove the provider did no billable
        // work, so the failed call keeps its reservation.
        const calls = Object.values(accounting.state.calls);

        expect(calls).toHaveLength(2);
        expect(calls.filter((call) => !call.usage)).toHaveLength(1);
      },
    );

    it.each([
      [
        'a lost ledger owner',
        new ModelBudgetError('Owner changed', 'ownership'),
      ],
      [
        'a corrupt ledger',
        new ModelBudgetError('Persisted model budget is invalid', 'integrity'),
      ],
      [
        'an output the host schema refuses',
        Object.assign(new Error('Invalid input'), { name: 'ZodError' }),
      ],
    ] as const)(
      'should propagate %s instead of recording a gap',
      async (_name, error) => {
        const result = extractClaimCandidates({
          answers: answers(6),
          product: 'Deno',
          role,
          accounting: ledger(),
          transport: failingOn(error),
        });

        await expect(result).rejects.toBe(error);
      },
    );
  });
});
