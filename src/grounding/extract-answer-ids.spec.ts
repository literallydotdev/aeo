import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMemoryModelAccounting } from '../models/accounting';
import type { InternalModelRoleConfig } from '../models/profiles';
import type { StructuredTransport } from '../models/structured';
import { contentHash } from '../stores/content-hash';
import { requireDefined } from '../__fixtures__/require-defined';
import type { SavedAnswer } from './schema';
import {
  claimExtractionSchema,
  extractClaimCandidates,
  type ValidatedExtractionBatch,
} from './extract';

// This role and cache key were captured before the batch enum was introduced.
// Pin them independently of future changes to the default model profile.
const role: InternalModelRoleConfig = {
  model: 'openai/gpt-6-astra',
  providerOptions: { openai: { reasoningEffort: 'high' } },
  promptVersion: 'perception-grounding-v1',
  schemaVersion: 'perception-v1',
  deadlineMs: 300_000,
  maxInputTokens: 80_000,
  maxOutputTokens: 16_384,
  pricingUsdPerMillion: { input: 10, output: 50, cachedInput: 1 },
};

const legacyKey =
  'claim-extraction-batch:edb97d66dd8370c81a7d3b5695cc28ce99a931c83b82ebbd88e00e036278309c';

const answer: SavedAnswer = {
  id: 'runtime|chatgpt|p1|0|ae57392027dd3bce675a2f887653c2def63a70856e1f4badad8792ddc4b22a2f',
  runId: 'run-1',
  section: 'runtime',
  promptId: 'p1',
  surface: 'chatgpt',
  runIndex: 0,
  capturedAt: '2026-09-09T00:00:00.000Z',
  text: 'Deno supports TypeScript.',
  digest: 'fa944b6a2b200dea307d047002627e9c10dc571b17c3f92ac1f599c5c01a4b53',
};

const claim = (answerId = answer.id, quote = answer.text) => {
  return {
    answerId,
    proposition: quote,
    quote,
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

const ledger = () => {
  return createMemoryModelAccounting({
    maxUsd: 100,
    maxTokens: 1_000_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });
};

const freeUsage = { costUsd: 0, inputTokens: 1, outputTokens: 1 };

const singleClaimTransport: StructuredTransport = (input) => {
  return Promise.resolve({
    output: input.schema.parse({ claims: [claim()] }),
    usage: freeUsage,
  });
};

const unexpectedTransport = (message: string) => {
  return vi.fn(() => Promise.reject(new Error(message)));
};

const noCachedBatch = () => {
  return vi.fn(() =>
    Promise.resolve<ValidatedExtractionBatch | undefined>(undefined),
  );
};

const ignorePut = () => {
  return Promise.resolve();
};

type ExtractionResult = Awaited<ReturnType<typeof extractClaimCandidates>>;

const firstOccurrence = (result: ExtractionResult) => {
  const candidate = requireDefined(result.candidates[0], 'first candidate');

  return requireDefined(candidate.occurrences[0], 'first occurrence');
};

const corruptErrors = {
  'cache key': 'cache identity mismatch',
  'answer ID': 'unknown_answer_id',
  'quote': 'quote_not_found',
} as const;

describe('extract - extractClaimCandidates() answer identities', () => {
  it('should reuse a pre-enum validated batch without a model call or new reservation', async () => {
    const cached: ValidatedExtractionBatch = {
      kind: 'validated_extraction_batch',
      version: 1,
      key: legacyKey,
      callId: 'pre-enum-call',
      output: { claims: [claim()] },
    };
    const accounting = ledger();
    const transport = unexpectedTransport(
      'Unexpected model call for a validated batch.',
    );
    const get = vi.fn((key: string) =>
      Promise.resolve(key === legacyKey ? cached : undefined),
    );
    const put = vi.fn();

    const result = await extractClaimCandidates({
      answers: [answer],
      product: 'Deno',
      role,
      accounting,
      transport,
      batchCache: { get, put },
    });

    expect(get).toHaveBeenCalledExactlyOnceWith(legacyKey);
    expect(result.coverage.extractedAnswers).toBe(1);
    expect(firstOccurrence(result)).toMatchObject({
      answerId: answer.id,
      quote: answer.text,
      start: 0,
      end: answer.text.length,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(Object.keys(accounting.state.calls)).toHaveLength(0);
  });

  it('should reuse proved original-capture proposals while rebuilding occurrences for the current run', async () => {
    const currentAnswer = { ...answer, runId: 'recovery-run' };
    const cached: ValidatedExtractionBatch = {
      kind: 'validated_extraction_batch',
      version: 1,
      key: legacyKey,
      callId: 'original-paid-call',
      output: { claims: [claim()] },
    };
    const originalCache = structuredClone(cached);
    const get = vi.fn((key: string) =>
      Promise.resolve(key === legacyKey ? cached : undefined),
    );
    const put = vi.fn();
    const transport = unexpectedTransport(
      'Unexpected dispatch for preserved captures.',
    );
    const accounting = ledger();

    const result = await extractClaimCandidates({
      answers: [currentAnswer],
      product: 'Deno',
      role,
      accounting,
      transport,
      batchCache: { get, put },
      priorAnswerRunIds: { [answer.id]: answer.runId },
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0]?.[0]).not.toBe(legacyKey);
    expect(get.mock.calls[1]?.[0]).toBe(legacyKey);
    expect(firstOccurrence(result)).toMatchObject({
      answerId: answer.id,
      runId: 'recovery-run',
      capturedAt: answer.capturedAt,
      answerDigest: answer.digest,
      quote: answer.text,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(Object.keys(accounting.state.calls)).toHaveLength(0);
    expect(cached).toEqual(originalCache);
  });

  it.each([
    ['omitted', undefined],
    ['unknown origin', {}],
    ['empty origin', { [answer.id]: '' }],
    ['only another answer', { foreign: answer.runId }],
    ['same current run', { [answer.id]: 'recovery-run' }],
  ] as const)(
    'should NOT try an unproved legacy cache (%s)',
    async (_name, priorAnswerRunIds) => {
      const get = noCachedBatch();
      const accounting = ledger();

      await extractClaimCandidates({
        answers: [{ ...answer, runId: 'recovery-run' }],
        product: 'Deno',
        role,
        accounting,
        transport: singleClaimTransport,
        batchCache: { get, put: ignorePut },
        priorAnswerRunIds,
      });

      expect(get).toHaveBeenCalledTimes(1);
      expect(Object.keys(accounting.state.calls)).toHaveLength(1);
    },
  );

  it.each(['text', 'capturedAt', 'promptId', 'product', 'role'] as const)(
    'should NOT reuse original proposals after %s changes',
    async (changed) => {
      const current = { ...answer, runId: 'recovery-run' };

      if (changed === 'text') {
        current.text += ' The answer changed.';
        current.digest = contentHash(current.text);
      }

      if (changed === 'capturedAt') {
        current.capturedAt = '2026-09-10T00:00:00.000Z';
      }

      if (changed === 'promptId') {
        current.promptId = 'another-question';
      }

      const get = vi.fn(
        (key: string): Promise<ValidatedExtractionBatch | undefined> =>
          Promise.resolve(
            key === legacyKey
              ? {
                  kind: 'validated_extraction_batch',
                  version: 1,
                  key,
                  callId: 'old',
                  output: { claims: [claim()] },
                }
              : undefined,
          ),
      );
      const accounting = ledger();
      const transport: StructuredTransport = (input) => {
        return Promise.resolve({
          output: input.schema.parse({
            claims: [claim(current.id, current.text)],
          }),
          usage: freeUsage,
        });
      };

      await extractClaimCandidates({
        answers: [current],
        product: changed === 'product' ? 'Another product' : 'Deno',
        role: changed === 'role' ? { ...role, promptVersion: 'changed' } : role,
        accounting,
        transport,
        batchCache: { get, put: ignorePut },
        priorAnswerRunIds: { [answer.id]: answer.runId },
      });

      expect(get).toHaveBeenCalledTimes(2);
      expect(get.mock.calls.every(([key]) => key !== legacyKey)).toBe(true);
      expect(Object.keys(accounting.state.calls)).toHaveLength(1);
    },
  );

  it('should require proved lineage for every answer in a batch', async () => {
    const answers = [
      { ...answer, runId: 'recovery-run' },
      { ...answer, id: 'unknown-origin-answer', runId: 'recovery-run' },
    ];
    const get = noCachedBatch();

    await extractClaimCandidates({
      answers,
      product: 'Deno',
      role,
      accounting: ledger(),
      transport: singleClaimTransport,
      batchCache: { get, put: ignorePut },
      priorAnswerRunIds: { [answer.id]: answer.runId },
    });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('should reuse a batch first generated during a retry on a later retry without changing its paid call', async () => {
    const entries = new Map<string, ValidatedExtractionBatch>();
    const accounting = ledger();
    let dispatched = 0;
    const transport: StructuredTransport = (input) => {
      dispatched += 1;

      return Promise.resolve({
        output: input.schema.parse({ claims: [claim()] }),
        usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 20 },
      });
    };
    const put = vi.fn((key: string, value: ValidatedExtractionBatch) => {
      entries.set(key, value);

      return Promise.resolve();
    });
    const input = {
      product: 'Deno',
      role,
      accounting,
      transport,
      priorAnswerRunIds: { [answer.id]: answer.runId },
      batchCache: {
        get: (key: string) => Promise.resolve(entries.get(key)),
        put,
      },
    };

    const firstRetry = await extractClaimCandidates({
      ...input,
      answers: [{ ...answer, runId: 'retry-1' }],
    });

    const paidCallId = requireDefined(
      Object.keys(accounting.state.calls)[0],
      'paid call id',
    );
    const retained = structuredClone(entries.get(legacyKey));

    expect(retained).toMatchObject({ key: legacyKey, callId: paidCallId });

    const secondRetry = await extractClaimCandidates({
      ...input,
      answers: [{ ...answer, runId: 'retry-2' }],
    });

    expect(firstOccurrence(firstRetry).runId).toBe('retry-1');
    expect(firstOccurrence(secondRetry).runId).toBe('retry-2');
    expect(firstOccurrence(secondRetry).quote).toBe(answer.text);
    expect(dispatched).toBe(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(entries.size).toBe(1);
    expect(entries.get(legacyKey)).toEqual(retained);
    expect(Object.keys(accounting.state.calls)).toEqual([paidCallId]);
    expect(accounting.state.calls[paidCallId]?.usage?.costUsd).toBe(0.25);
  });

  it('should NOT fall back around a corrupt current-run cache entry', async () => {
    const get = vi.fn((key: string): Promise<ValidatedExtractionBatch> =>
      Promise.resolve({
        kind: 'validated_extraction_batch',
        version: 1,
        key,
        callId: 'current-call',
        output: { claims: [claim(answer.id, 'Fabricated text.')] },
      }),
    );
    const transport = unexpectedTransport('Unexpected retry.');

    const result = extractClaimCandidates({
      answers: [{ ...answer, runId: 'recovery-run' }],
      product: 'Deno',
      role,
      accounting: ledger(),
      transport,
      batchCache: { get, put: ignorePut },
      priorAnswerRunIds: { [answer.id]: answer.runId },
    });

    await expect(result).rejects.toThrow('quote_not_found');
    expect(get).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['cache key', 'answer ID', 'quote'] as const)(
    'should reject a corrupt legacy %s instead of treating lineage as validation',
    async (changed) => {
      const cachedClaim = claim();
      const cached: ValidatedExtractionBatch = {
        kind: 'validated_extraction_batch',
        version: 1,
        key: legacyKey,
        callId: 'original-paid-call',
        output: { claims: [cachedClaim] },
      };

      if (changed === 'cache key') {
        cached.key = 'another-key';
      }

      if (changed === 'answer ID') {
        cachedClaim.answerId = 'foreign';
      }

      if (changed === 'quote') {
        cachedClaim.quote = 'A fabricated quote.';
      }

      const transport = unexpectedTransport('Unexpected retry.');
      const put = vi.fn();

      const result = extractClaimCandidates({
        answers: [{ ...answer, runId: 'recovery-run' }],
        product: 'Deno',
        role,
        accounting: ledger(),
        transport,
        batchCache: {
          get: (key) => Promise.resolve(key === legacyKey ? cached : undefined),
          put,
        },
        priorAnswerRunIds: { [answer.id]: answer.runId },
      });

      await expect(result).rejects.toThrow(corruptErrors[changed]);
      expect(transport).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    },
  );

  it('should send only each current batch’s exact canonical IDs in the model-facing JSON schema', async () => {
    const answers = Array.from({ length: 4 }, (_, index) => ({
      ...answer,
      id: `${answer.id}-${index}`,
      text: `Deno capability ${index}.`,
      digest: contentHash(`Deno capability ${index}.`),
    }));
    const supplied: string[][] = [];
    const transport: StructuredTransport = (input) => {
      const { answers: batch } = JSON.parse(input.prompt) as {
        answers: SavedAnswer[];
      };
      const ids = batch.map((value) => value.id);

      supplied.push(ids);

      expect(z.toJSONSchema(input.schema)).toMatchObject({
        properties: {
          claims: {
            items: { properties: { answerId: { enum: ids } } },
          },
        },
      });

      for (const other of answers.filter((value) => !ids.includes(value.id))) {
        expect(
          input.schema.safeParse({ claims: [claim(other.id, other.text)] })
            .success,
        ).toBe(false);
      }

      return Promise.resolve({
        output: input.schema.parse({
          claims: batch.map((value) => claim(value.id, value.text)),
        }),
        usage: freeUsage,
      });
    };

    const result = await extractClaimCandidates({
      answers,
      product: 'Deno',
      role,
      accounting: ledger(),
      transport,
    });

    expect(supplied).toEqual([
      answers.slice(0, 3).map((value) => value.id),
      [answers[3]?.id],
    ]);
    expect(result.coverage.extractedAnswers).toBe(4);
  });

  it.each(['foreign-answer', answer.id.slice(0, -12)])(
    'should reject a provider’s invalid ID %s without repairing or caching it',
    async (answerId) => {
      const accounting = ledger();
      const put = vi.fn();
      // Simulate a provider ignoring the schema. The structured-call boundary
      // must still reject the output even though its quote is exactly valid.
      const transport: StructuredTransport = () => {
        return Promise.resolve({
          output: claimExtractionSchema.parse({
            claims: [claim(answerId)],
          }) as never,
          usage: { costUsd: 0.01, inputTokens: 1, outputTokens: 1 },
        });
      };

      const result = extractClaimCandidates({
        answers: [answer],
        product: 'Deno',
        role,
        accounting,
        transport,
        batchCache: { get: () => Promise.resolve(undefined), put },
      });

      await expect(result).rejects.toMatchObject({ name: 'ZodError' });
      expect(put).not.toHaveBeenCalled();

      const calls = Object.values(accounting.state.calls);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.usage?.costUsd).toBe(0.01);
    },
  );

  it('should drop another answer’s quotation even when both IDs are allowed in the batch', async () => {
    const other = {
      ...answer,
      id: `${answer.id}-other`,
      text: 'Deno has a built-in formatter.',
      digest: contentHash('Deno has a built-in formatter.'),
    };
    const put = vi.fn();
    const onDiagnostic = vi.fn();
    const transport: StructuredTransport = (input) => {
      return Promise.resolve({
        output: input.schema.parse({ claims: [claim(answer.id, other.text)] }),
        usage: freeUsage,
      });
    };

    // A claim attributed to one answer but quoting another is the model's
    // mistake about that claim. It is dropped, so it never reaches a reader,
    // the batch is not cached because it is no longer a settled result, and
    // the coverage records the loss against the answer it was attributed to.
    const result = await extractClaimCandidates({
      answers: [answer, other],
      product: 'Deno',
      role,
      accounting: ledger(),
      transport,
      batchCache: { get: () => Promise.resolve(undefined), put },
      onDiagnostic,
    });

    expect(result.candidates).toEqual([]);
    expect(result.coverage).toMatchObject({
      extractedAnswers: 2,
      droppedClaims: 1,
      droppedClaimsByAnswer: [{ answerId: answer.id, claims: 1 }],
    });
    expect(put).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ trusted: false, reason: 'quote_not_found' }),
    );
  });
});
