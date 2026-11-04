import { assert, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMemoryModelAccounting } from '../models/accounting';
import { resolveInternalModelProfile } from '../models/profiles';
import { structuredCallReservation } from '../models/structured';
import type { GroundingSource } from '../grounding/schema';
import type { ReportFact } from './facts';
import {
  InvalidReviewError,
  classifyVerifierFailure,
  type RecommendationInput,
} from './copy-validation';
import {
  checkPremiseVerdicts,
  createRecommendationVerifier,
  premiseVerifierCall,
  verdictSchemaFor,
  verifierChunks,
  type VerifierHistory,
} from './verifier';

const premiseProposition = 'The retirement date is doubtful.';
const capturedFact = {
  kind: 'measurement' as const,
  factId: 'aggregate:captured',
  runId: 'run-1',
  section: null,
  surface: null,
  entity: 'Example',
  metric: 'captured_answers',
  numerator: 120,
  denominator: null,
  unit: 'count' as const,
  sentence: 'This audit captured 120 answers.',
};
const input: RecommendationInput = {
  kind: 'recommendation',
  path: 'actionPlan.0',
  text: 'Review the retirement date.',
  intendedAction: 'Check the retirement date.',
  premises: [
    {
      proposition: premiseProposition,
      basisFactIds: ['aggregate:captured'],
    },
  ],
  facts: [capturedFact],
};

/**
 * createVerdict builds a passing verifier output for `input`, and exposes its
 * single review and premise so a test can alter them in place.
 */
const createVerdict = () => {
  const premise = {
    proposition: premiseProposition,
    declaredPremiseIndex: 0 as number | null,
    basisFactIds: ['aggregate:captured'],
    supported: true,
    relevant: true,
  };
  const review = {
    path: input.path,
    passed: true,
    allPremisesCovered: true,
    actionAppropriate: true,
    premises: [premise],
    errors: [] as string[],
  };

  return { output: { reviews: [review] }, review, premise };
};

const createAccounting = () => {
  return createMemoryModelAccounting({
    maxUsd: 3,
    maxTokens: 200_000,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
};

const astraVerifierProfile =
  resolveInternalModelProfile('astra-grounding-v1').roles.premiseVerifier;

const memoryPromptSchema = z.object({
  previousEdits: z.unknown().optional(),
  inputs: z.array(
    z.object({
      previousReviews: z.unknown().optional(),
      previousEdits: z.unknown().optional(),
    }),
  ),
});

const sourcesPromptSchema = z.object({
  sources: z.unknown().optional(),
  facts: z.array(
    z.object({
      productFact: z.object({ references: z.unknown() }).optional(),
      sources: z.unknown().optional(),
    }),
  ),
});

describe('verifier - createRecommendationVerifier() memory', () => {
  it('should retain the earlier copy review when a revised draft is verified by a replacement worker', async () => {
    let saved: VerifierHistory = {};
    const edits = [
      { draft: 'earlier wording', editedDraft: 'Revised wording' },
    ];
    const memory = {
      read: () => Promise.resolve(structuredClone(saved)),
      write: (history: VerifierHistory) => {
        saved = structuredClone(history);

        return Promise.resolve();
      },
      edits: () => Promise.resolve(structuredClone(edits)),
    };
    const accounting = createAccounting();
    const usage = { inputTokens: 100, outputTokens: 100, costUsd: 0.001 };
    const first = createRecommendationVerifier({
      accounting,
      profile: astraVerifierProfile,
      memory,
      transport: (request) => {
        return Promise.resolve({
          output: request.schema.parse(createVerdict().output),
          usage,
        });
      },
    });
    const replacement = createRecommendationVerifier({
      accounting,
      profile: astraVerifierProfile,
      memory,
      transport: (request) => {
        const sent = memoryPromptSchema.parse(JSON.parse(request.prompt));

        expect(sent.inputs[0]?.previousReviews).toEqual([
          { text: input.text, review: createVerdict().review },
        ]);
        expect(sent.previousEdits).toEqual(edits);
        expect(sent.inputs[0]?.previousEdits).toBeUndefined();
        expect(request.system).toContain(
          'Earlier verdicts and edits are review context, not factual evidence',
        );

        return Promise.resolve({
          output: request.schema.parse(createVerdict().output),
          usage,
        });
      },
    });

    await first([input]);

    const result = await replacement([{ ...input, text: 'Revised wording' }]);

    expect(result.valid).toBe(true);
    expect(saved[input.path]).toHaveLength(2);
  });
});

describe('verifier - verifierChunks()', () => {
  const block = (index: number): RecommendationInput => {
    return {
      ...input,
      text: `Recommendation ${index}`,
      path: `sections.s.body.${index}`,
    };
  };
  const blocks = Array.from({ length: 7 }, (_, index) => block(index));
  const base = resolveInternalModelProfile('astra-harness-v1', {}).roles
    .premiseVerifier;

  it('should pack by input size when the role sets no ceiling of its own', () => {
    const chunks = verifierChunks(blocks, base);

    expect(chunks.map((c) => c.length)).toEqual([7]);
  });

  it('should split by how many judgements a call carries when the role pins one', () => {
    // Fitting the input limit is the wrong test for a reasoning model: what
    // makes the call expensive is the number of verdicts it must think
    // through, and a call holding several ran to its cap without answering.
    const chunks = verifierChunks(blocks, { ...base, maxItemsPerCall: 3 });
    const singles = verifierChunks(blocks, { ...base, maxItemsPerCall: 1 });

    expect(chunks.map((c) => c.length)).toEqual([3, 3, 1]);
    // Every block is still verified exactly once, in order.
    expect(chunks.flat().map((c) => c.path)).toEqual(blocks.map((b) => b.path));
    expect(singles.map((c) => c.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('should fit a factual introduction by sending shared source passages once', () => {
    const firstPassage = {
      id: 'passage-1',
      text: 'Documented product capability. '.repeat(400),
      digest: 'c'.repeat(64),
    };
    const secondPassage = {
      id: 'passage-2',
      text: 'Available in Europe.',
      digest: 'd'.repeat(64),
    };
    const source: GroundingSource = {
      id: 'source-1',
      requestedUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      title: 'Product',
      publisher: 'Example',
      provenance: 'first_party',
      fetchedAt: '2026-09-14T00:00:00Z',
      sourceDate: null,
      documentDigest: 'a'.repeat(64),
      retainedDigest: 'b'.repeat(64),
      extractionVersion: 1,
      truncated: false,
      passages: [firstPassage],
    };
    const facts: ReportFact[] = Array.from({ length: 20 }, (_, index) => ({
      ...capturedFact,
      kind: 'product_fact',
      factId: `product:${index}`,
      groundingDigest: 'e'.repeat(64),
      productFact: {
        id: `fact-${index}`,
        proposition: `Capability ${index}`,
        scope: {
          product: 'Example',
          generation: null,
          version: null,
          applicableAt: null,
        },
        references: [
          {
            sourceId: source.id,
            passageId: index === 19 ? secondPassage.id : firstPassage.id,
          },
        ],
        status: 'supported',
        reason: 'Explicit source statement',
      },
      sources: [
        {
          ...source,
          passages: index === 19 ? [secondPassage] : source.passages,
        },
      ],
    }));
    const [firstFact] = facts;
    const lastFact = facts[19];
    const narrative = { ...input, kind: 'narrative' as const, facts };

    assert(firstFact?.kind === 'product_fact');
    assert(lastFact?.kind === 'product_fact');

    const wire = sourcesPromptSchema.parse(
      JSON.parse(premiseVerifierCall([narrative], base).prompt),
    );

    expect(() => verifierChunks([narrative], base)).not.toThrow();
    expect(wire.sources).toEqual([
      { ...source, passages: [...source.passages, secondPassage] },
    ]);
    expect(wire.facts).toHaveLength(20);
    expect(wire.facts[19]?.productFact?.references).toEqual(
      lastFact.productFact.references,
    );
    expect(wire.facts.every((fact) => fact.sources === undefined)).toBe(true);
    expect(firstFact.sources[0]?.passages).toEqual(source.passages);
  });

  it('should send the edit history once per call however many narrative blocks it judges', () => {
    // Five retained edits each carry a full draft: 30 KB here against the
    // role's 80 KB input limit. Spread onto every block, the intro, headline
    // and subtitle carried the history three times and a chunk under the
    // block ceiling failed the input limit deterministically.
    const marker = 'EDIT-HISTORY-MARKER';
    const previousEdits = Array.from({ length: 5 }, (_, round) => ({
      round: round + 1,
      findings: [`Finding ${round + 1}`],
      editedDraft: { intro: `${marker} ${'edited wording '.repeat(400)}` },
    }));
    const historyBytes = Buffer.byteLength(JSON.stringify(previousEdits));
    const narrative = (path: string): RecommendationInput => {
      return {
        ...input,
        kind: 'narrative',
        path,
        text: `Narrative for ${path}`,
      };
    };
    const narratives = ['intro.0', 'hero.title', 'hero.subtitle'].map(
      narrative,
    );
    const [firstNarrative] = narratives;
    const occurrences = (text: string) => {
      return text.split(marker).length - 1;
    };

    assert(firstNarrative);
    expect(historyBytes * 3).toBeGreaterThan(base.maxInputTokens);

    const single = premiseVerifierCall([firstNarrative], base, {
      previousEdits,
    });
    const all = premiseVerifierCall(narratives, base, { previousEdits });
    const withoutHistory = premiseVerifierCall(narratives, base);

    expect(occurrences(single.prompt)).toBe(5);
    expect(occurrences(all.prompt)).toBe(5);

    const wire = memoryPromptSchema.parse(JSON.parse(all.prompt));

    expect(wire.previousEdits).toEqual(previousEdits);
    expect(wire.inputs).toHaveLength(3);
    expect(
      wire.inputs.every((entry) => entry.previousEdits === undefined),
    ).toBe(true);
    // The fitter sizes the same call the dispatcher sends: the history is
    // counted once, so the three blocks still travel together.
    expect(
      verifierChunks(narratives, base, { previousEdits }).map((c) => c.length),
    ).toEqual([3]);
    expect(
      structuredCallReservation(all).inputTokens -
        structuredCallReservation(single).inputTokens,
    ).toBeLessThan(historyBytes);
    // Without a history nothing is added to the prompt.
    expect(
      memoryPromptSchema.parse(JSON.parse(withoutHistory.prompt)).previousEdits,
    ).toBeUndefined();
  });
});

describe('verifier - checkPremiseVerdicts()', () => {
  it('should separate verifier omissions from findings against the copy', () => {
    // No verdict, a skipped declared premise and an invented basis are the
    // verifier's failures: verification repeats, the draft is not revised.
    const missing = createVerdict();
    missing.review.premises = [];
    const unknown = createVerdict();
    unknown.premise.basisFactIds = ['invented-source'];
    // A fact another block in the same call supplied is a legal basis.
    const sibling = {
      ...input,
      path: 'hero.title.0',
      facts: [{ ...capturedFact, factId: 'sibling-fact' }],
    };
    const borrowed = createVerdict();
    const borrowedSibling = createVerdict();
    borrowed.premise.basisFactIds = ['sibling-fact'];
    borrowedSibling.review.path = 'hero.title.0';
    borrowedSibling.premise.basisFactIds = ['sibling-fact'];
    borrowed.output.reviews.push(borrowedSibling.review);
    // An irrelevant but supported premise on a passing verdict is a note,
    // not a contradiction (Opus, 2026-09-13).
    const irrelevantPass = createVerdict();
    irrelevantPass.premise.relevant = false;
    // An irrelevant basis on a failed verdict is a finding against the copy.
    const irrelevant = createVerdict();
    irrelevant.review.passed = false;
    irrelevant.premise.relevant = false;

    expect(checkPremiseVerdicts([input], { reviews: [] })).toEqual({
      rejections: [],
      invalid: [`${input.path}: no verdict was returned for this block`],
    });
    expect(checkPremiseVerdicts([input], missing.output)).toEqual({
      rejections: [],
      invalid: [`${input.path}: declared premise was not reviewed`],
    });
    expect(checkPremiseVerdicts([input], unknown.output)).toEqual({
      rejections: [],
      invalid: [`${input.path}: verifier cited a fact it was not given`],
    });
    expect(checkPremiseVerdicts([input, sibling], borrowed.output)).toEqual({
      rejections: [],
      invalid: [],
    });
    expect(checkPremiseVerdicts([input], irrelevantPass.output)).toEqual({
      rejections: [],
      invalid: [],
    });
    expect(checkPremiseVerdicts([input], irrelevant.output)).toEqual({
      rejections: [`${input.path}: unsupported or irrelevant premise`],
      invalid: [],
    });
  });

  // Fixtures from execution 01M2ASSJDA7656TSRTZ8WFNEWR (2026-09-12): GLM
  // approved blocks while writing "None found." and "none" into `errors`,
  // and the host spent two of the three copy generations on them.
  it('should let a passing verdict carry placeholder text in errors', () => {
    const noise = createVerdict();
    noise.review.errors = ['None found.'];

    const result = checkPremiseVerdicts([input], noise.output);

    expect(result).toEqual({ rejections: [], invalid: [] });
  });

  it('should reject the block on a failed verdict whose only finding is its wording', () => {
    const failed = createVerdict();
    failed.review.passed = false;
    failed.review.errors = [
      "Unsupported attribution: no supplied fact identifies the audit's publisher.",
    ];

    const result = checkPremiseVerdicts([input], failed.output);

    expect(result).toEqual({
      rejections: [`${input.path}: verifier rejected the block`],
      invalid: [],
    });
  });

  it('should fail the block on an unsupported premise whatever the block flag says, and refuse a failure that names nothing', () => {
    // The premise findings are the evidence: a pass over an unsupported
    // premise is a finding the verifier then edits, not an invalid review
    // (six identical refusals failed the Botpress copy pass, 2026-09-15).
    const passedOverUnsupported = createVerdict();
    passedOverUnsupported.premise.supported = false;
    const failedWithoutFinding = createVerdict();
    failedWithoutFinding.review.passed = false;

    const unsupported = checkPremiseVerdicts(
      [input],
      passedOverUnsupported.output,
    );
    const unnamed = checkPremiseVerdicts([input], failedWithoutFinding.output);

    expect(unsupported).toEqual({
      rejections: [`${input.path}: unsupported or irrelevant premise`],
      invalid: [],
    });
    expect(unnamed).toEqual({
      rejections: [],
      invalid: [
        `${input.path}: verdict failed the block without naming a problem`,
      ],
    });
  });
});

describe('verifier - verdictSchemaFor()', () => {
  it('should require the verdict flag on the wire', () => {
    const { passed: _passed, ...withoutFlag } = createVerdict().review;

    const result = verdictSchemaFor(
      [input.path],
      ['aggregate:captured'],
    ).safeParse({ reviews: [withoutFlag] });

    expect(result.success).toBe(false);
  });
});

describe('verifier - createRecommendationVerifier() evidence', () => {
  it('should supply the complete cited facts and block the softened unsupported retirement action', async () => {
    const accounting = createAccounting();
    let requestPrompt = '';
    const verify = createRecommendationVerifier({
      accounting,
      profile: astraVerifierProfile,
      transport: (request) => {
        requestPrompt = request.prompt;

        expect(request.system).toContain(
          'including implications hidden in Review, Check',
        );

        const rejected = createVerdict();
        rejected.review.passed = false;
        rejected.premise.supported = false;
        rejected.review.actionAppropriate = false;
        rejected.review.errors.push(
          'Capture totals do not establish a retirement date.',
        );

        return Promise.resolve({
          output: request.schema.parse(rejected.output),
          usage: { inputTokens: 400, outputTokens: 100, costUsd: 0.01 },
        });
      },
    });

    const result = await verify([input]);

    expect(result.valid).toBe(false);
    expect(result.model).toBe('openai/gpt-6-astra');
    expect(result.issues).toEqual([
      {
        code: 'premise_unsupported',
        path: input.path,
        message: 'Capture totals do not establish a retirement date.',
      },
    ]);
    expect(requestPrompt).toContain('This audit captured 120 answers.');
    expect(Object.keys(accounting.state.calls)).toHaveLength(1);
  });
});

describe('verifier - createRecommendationVerifier() unusable verdicts', () => {
  it('should repeat verification of the unchanged draft instead of revising it', async () => {
    const verify = createRecommendationVerifier({
      accounting: createAccounting(),
      profile: astraVerifierProfile,
      transport: (request) => {
        // The declared premise is skipped: only an implicit one is judged.
        const skipped = createVerdict();
        skipped.premise.declaredPremiseIndex = null;

        return Promise.resolve({
          output: request.schema.parse(skipped.output),
          usage: { inputTokens: 400, outputTokens: 100, costUsd: 0.01 },
        });
      },
    });

    const error = await verify([input]).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(InvalidReviewError);
    // The block is re-asked with the skipped premise named; a verifier that
    // skips it every time leaves the block unreviewed, never the copy revised.
    expect(error).toMatchObject({
      reason: 'unreviewed_blocks',
      paths: [input.path],
    });
    expect(classifyVerifierFailure(error)).toBe('invalid_review');
  });

  it('should NOT let text on a passing verdict reject the block', async () => {
    const verify = createRecommendationVerifier({
      accounting: createAccounting(),
      profile: astraVerifierProfile,
      transport: (request) => {
        const noise = createVerdict();
        noise.review.errors = ['none'];

        return Promise.resolve({
          output: request.schema.parse(noise.output),
          usage: { inputTokens: 400, outputTokens: 100, costUsd: 0.01 },
        });
      },
    });

    const result = await verify([input]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});
