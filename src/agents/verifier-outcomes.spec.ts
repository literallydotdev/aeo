import { assert, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ModelBudgetError,
  createMemoryModelAccounting,
} from '../models/accounting';
import { ModelCallAbortError } from '../models/errors';
import { testModelProfileFixture } from '../models/profile-fixture';
import {
  structuredCallReservation,
  type StructuredTransport,
} from '../models/structured';
import {
  InvalidReviewError,
  classifyVerifierFailure,
  type RecommendationInput,
} from './copy-validation';
import {
  createRecommendationVerifier,
  premiseVerifierCall,
  verdictSchemaFor,
  verifierChunks,
} from './verifier';

const profile = testModelProfileFixture().roles.premiseVerifier;
const fact = (id: string, size = 10) => {
  return {
    factId: id,
    kind: 'aggregate' as const,
    section: null,
    sentence: 'x'.repeat(size),
  };
};
const input = (path: string, size = 10): RecommendationInput => {
  return {
    text: `Consider reviewing ${path}.`,
    kind: 'recommendation',
    intendedAction: 'Review.',
    premises: [{ proposition: 'p', basisFactIds: [`f-${path}`] }],
    facts: [fact(`f-${path}`, size) as never],
    path,
  };
};

const sentPromptSchema = z.object({
  inputs: z.array(
    z.object({
      path: z.string(),
      premises: z.array(z.object({ basisFactIds: z.array(z.string()) })),
      unreviewedPremiseIndexes: z.array(z.number()).optional(),
    }),
  ),
});

type SentBlock = z.infer<typeof sentPromptSchema>['inputs'][number];

/** sentBlocks reads back the blocks a call was sent from its prompt. */
const sentBlocks = (prompt: string) => {
  return sentPromptSchema.parse(JSON.parse(prompt)).inputs;
};

const firstSentBlock = (prompt: string) => {
  const [first] = sentBlocks(prompt);

  assert(first, 'Expected the call to send at least one block.');

  return first;
};

const approve = (entry: Pick<SentBlock, 'path' | 'premises'>) => {
  const [premise] = entry.premises;

  assert(premise, `Expected a declared premise for ${entry.path}.`);

  return {
    path: entry.path,
    passed: true,
    allPremisesCovered: true,
    actionAppropriate: true,
    premises: [
      {
        proposition: 'p',
        declaredPremiseIndex: 0,
        basisFactIds: premise.basisFactIds,
        supported: true,
        relevant: true,
      },
    ],
    errors: [],
  };
};
const usage = { costUsd: 0.01, inputTokens: 10, outputTokens: 10 };

const verifier = (
  transport: StructuredTransport,
  role = profile,
): ReturnType<typeof createRecommendationVerifier> => {
  return createRecommendationVerifier({
    accounting: createMemoryModelAccounting({
      maxUsd: 100,
      maxTokens: 10_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    }),
    profile: role,
    transport,
  });
};

describe('copy-validation - classifyVerifierFailure()', () => {
  it('should map provider, budget, cancellation and schema failures to distinguishable outcomes', () => {
    expect(
      classifyVerifierFailure(
        Object.assign(new Error('t'), { name: 'GatewayTimeoutError' }),
      ),
    ).toBe('verifier_unavailable');
    expect(
      classifyVerifierFailure(
        Object.assign(new Error('500'), { statusCode: 500 }),
      ),
    ).toBe('verifier_unavailable');
    expect(
      classifyVerifierFailure(new ModelBudgetError('x', 'exhausted')),
    ).toBe('budget_exhausted');
    expect(classifyVerifierFailure(new ModelBudgetError('x', 'deadline'))).toBe(
      'budget_exhausted',
    );
    expect(
      classifyVerifierFailure(new ModelBudgetError('x', 'ownership')),
    ).toBe('integrity_error');
    expect(
      classifyVerifierFailure(new ModelCallAbortError('cancelled', null)),
    ).toBe('cancelled');
    expect(
      classifyVerifierFailure(new ModelCallAbortError('deadline', null)),
    ).toBe('verifier_unavailable');
    expect(classifyVerifierFailure(new Error('x'), AbortSignal.abort())).toBe(
      'cancelled',
    );
    expect(
      classifyVerifierFailure(
        Object.assign(new Error('z'), { name: 'ZodError' }),
      ),
    ).toBe('invalid_review');
    expect(classifyVerifierFailure(new Error('model_output_limit'))).toBe(
      'invalid_review',
    );
    expect(classifyVerifierFailure(new Error('model_input_limit'))).toBe(
      'invalid_review',
    );
    expect(
      classifyVerifierFailure(
        new InvalidReviewError('unreviewed_blocks', ['intro.0']),
      ),
    ).toBe('invalid_review');
  });
});

describe('verifier - createRecommendationVerifier() paging', () => {
  it('should page oversized inputs into sequential calls without dropping a block', async () => {
    // The fixed instructions and response schema alone need several thousand
    // bytes; leave room for roughly two blocks per call.
    const small = { ...profile, maxInputTokens: 12_000 };
    const inputs = Array.from({ length: 6 }, (_, index) =>
      input(`intro.${index}`, 1500),
    );
    let calls = 0;
    const transport: StructuredTransport = (call) => {
      calls += 1;

      return Promise.resolve({
        output: call.schema.parse({
          reviews: sentBlocks(call.prompt).map(approve),
        }),
        usage,
      });
    };

    const chunks = verifierChunks(inputs, small);
    const result = await verifier(transport, small)(inputs);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map((entry) => entry.path)).toEqual(
      inputs.map((entry) => entry.path),
    );
    expect(() => verifierChunks([input('huge', 20_000)], small)).toThrow(
      'model_input_limit',
    );
    expect(result.valid).toBe(true);
    expect(calls).toBe(chunks.length);
  });

  it('should size each chunk by the scoped schema it dispatches, so a chunk that fits is a chunk that dispatches', async () => {
    // Two blocks each citing twenty facts. The dispatched schema lists every
    // path and fact id as an enum, so it is larger than the free-form schema
    // the fitter used to size with; a limit between the two estimates let a
    // chunk pass the fitter and throw `model_input_limit` at reservation.
    const cited = (path: string) => {
      return Array.from({ length: 20 }, (_, index) =>
        fact(`fact-${path}-${'catalog'.repeat(4)}-${index}`),
      );
    };
    const block = (path: string): RecommendationInput => {
      const facts = cited(path);
      const [firstFact] = facts;

      assert(firstFact);

      return {
        ...input(path),
        premises: [{ proposition: 'p', basisFactIds: [firstFact.factId] }],
        facts: facts as never,
      };
    };
    const pair = [block('intro.0'), block('intro.1')];

    const call = premiseVerifierCall(pair, profile);
    const freeForm = structuredCallReservation({
      ...call,
      schema: verdictSchemaFor([], []),
    }).inputTokens;
    const scoped = structuredCallReservation(call).inputTokens;

    expect(scoped).toBeGreaterThan(freeForm);

    const pinned = {
      ...profile,
      maxInputTokens: Math.floor((freeForm + scoped) / 2),
    };

    const chunks = verifierChunks(pair, pinned);

    expect(chunks.map((chunk) => chunk.map((entry) => entry.path))).toEqual([
      ['intro.0'],
      ['intro.1'],
    ]);

    const [firstChunk, secondChunk] = chunks;

    assert(firstChunk && secondChunk);
    expect(() =>
      structuredCallReservation(premiseVerifierCall(firstChunk, pinned)),
    ).not.toThrow();
    expect(() =>
      structuredCallReservation(premiseVerifierCall(secondChunk, pinned)),
    ).not.toThrow();

    let calls = 0;
    const transport: StructuredTransport = (request) => {
      calls += 1;

      return Promise.resolve({
        output: request.schema.parse({
          reviews: sentBlocks(request.prompt).map(approve),
        }),
        usage,
      });
    };

    const result = await verifier(transport, pinned)(pair);

    expect(result.valid).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('verifier - createRecommendationVerifier() verdict coverage', () => {
  it('should ask again for exactly the blocks left without a verdict, one extra call, and merges', async () => {
    const inputs = [input('intro.0'), input('intro.1')];
    const sent: string[][] = [];
    const transport: StructuredTransport = (call) => {
      const blocks = sentBlocks(call.prompt);

      sent.push(blocks.map((entry) => entry.path));

      // The first call answers only the first block.
      const answered = sent.length === 1 ? blocks.slice(0, 1) : blocks;

      return Promise.resolve({
        output: call.schema.parse({ reviews: answered.map(approve) }),
        usage,
      });
    };

    const result = await verifier(transport)(inputs);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(sent).toEqual([['intro.0', 'intro.1'], ['intro.1']]);
  });

  it('should ask again for a block whose verdict skipped a declared premise, naming the skipped premise', async () => {
    // Opus skipped one premise in two blocks three calls running
    // (2026-09-13); the block is re-asked with the skipped indexes named.
    const block: RecommendationInput = {
      ...input('intro.0'),
      premises: [
        { proposition: 'p', basisFactIds: ['f-intro.0'] },
        { proposition: 'q', basisFactIds: ['f-intro.0'] },
      ],
    };
    const prompts: SentBlock[][] = [];
    const transport: StructuredTransport = (call) => {
      prompts.push(sentBlocks(call.prompt));

      const partial = approve(firstSentBlock(call.prompt));
      const [premise] = partial.premises;

      assert(premise);

      const complete = {
        ...partial,
        premises: [
          premise,
          { ...premise, proposition: 'q', declaredPremiseIndex: 1 },
        ],
      };

      return Promise.resolve({
        output: call.schema.parse({
          reviews: [prompts.length === 1 ? partial : complete],
        }),
        usage,
      });
    };

    const result = await verifier(transport)([block]);

    expect(result.valid).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.[0]?.unreviewedPremiseIndexes).toBeUndefined();
    expect(prompts[1]?.[0]?.unreviewedPremiseIndexes).toEqual([1]);
  });

  it('should refuse a review whose omissions survive the bounded re-asks as invalid_review, never invalid_copy', async () => {
    const inputs = Array.from({ length: 4 }, (_, index) =>
      input(`intro.${index}`),
    );
    let calls = 0;
    // One verdict per call, so every round adds something and only the
    // attempt bound ends it.
    const transport: StructuredTransport = (call) => {
      calls += 1;

      return Promise.resolve({
        output: call.schema.parse({
          reviews: [approve(firstSentBlock(call.prompt))],
        }),
        usage,
      });
    };

    const error = await verifier(transport)(inputs).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(InvalidReviewError);
    expect(error).toMatchObject({
      reason: 'unreviewed_blocks',
      paths: ['intro.3'],
    });
    expect(classifyVerifierFailure(error)).toBe('invalid_review');
    expect(calls).toBe(3);
  });

  it('should refuse two verdicts for one block as invalid_review instead of keeping the first', async () => {
    const inputs = [input('intro.0'), input('intro.1')];
    const transport: StructuredTransport = (call) => {
      const first = firstSentBlock(call.prompt);

      return Promise.resolve({
        output: call.schema.parse({
          reviews: [
            approve(first),
            { ...approve(first), passed: false, errors: ['Rejected'] },
          ],
        }),
        usage,
      });
    };

    const error = await verifier(transport)(inputs).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(InvalidReviewError);
    expect(error).toMatchObject({
      reason: 'duplicate_verdict',
      paths: ['intro.0'],
    });
    expect(classifyVerifierFailure(error)).toBe('invalid_review');
  });
});

describe('verifier - verdictSchemaFor()', () => {
  it('should tell the decoder a call answers at least one block and at most each once', () => {
    const schema = verdictSchemaFor(['a', 'b'], ['f']);
    const review = approve({ path: 'a', premises: [{ basisFactIds: ['f'] }] });

    expect(schema.safeParse({ reviews: [] }).success).toBe(false);
    expect(
      schema.safeParse({ reviews: [review, review, review] }).success,
    ).toBe(false);
    expect(schema.safeParse({ reviews: [review] }).success).toBe(true);
  });
});
