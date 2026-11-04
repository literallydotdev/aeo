import { describe, expect, it, vi } from 'vitest';
import { testModelProfileFixture } from '../models/profile-fixture';
import { groundingFixture } from '../agents/__fixtures__/grounding';
import {
  createMemoryModelAccounting,
  ModelBudgetError,
} from '../models/accounting';
import { structuredFailureDiagnostic } from '../models/failure-diagnostics';
import { internalModelRoleDigest } from '../models/profiles';
import {
  StructuredOutputMissingError,
  type StructuredTransport,
} from '../models/structured';
import { requireDefined } from '../__fixtures__/require-defined';
import type { GroundingDecisionInput } from './controller';
import { groundingEvaluationFixtures } from './evaluation-fixtures';
import { createGatewayGroundingModel } from './model';
import {
  heldOutScopeFixtures,
  materializeHeldOutScopeFixture,
} from './scope-heldout-fixtures';
import { researchActionSchema, type ResearchAction } from './tools';
import {
  createGroundingBundle,
  GroundingIntegrityError,
  validateGroundingBundle,
} from './validation';

type PromptView = {
  candidates: {
    id: string;
    scope: unknown;
    occurrences: { capturedAt: string | null }[];
  }[];
  sources: { passages: { text: string }[] }[];
  previousResults: unknown[];
  publicSearchTerms: string[];
};

const parsePrompt = (prompt: string) => {
  return JSON.parse(prompt) as PromptView;
};

describe('model - adjudication scope contract', () => {
  it('should preserve unknown scope and make the new instruction specific to the pinned v2 role', async () => {
    const profile = testModelProfileFixture();
    const v2Role = profile.roles.adjudication;
    const v1Role = { ...v2Role, promptVersion: 'adjudication-grounding-v1' };

    expect(v2Role.promptVersion).toBe('adjudication-grounding-v2');
    expect(internalModelRoleDigest(v1Role)).not.toBe(
      internalModelRoleDigest(v2Role),
    );

    const accounting = createMemoryModelAccounting({
      maxUsd: 10,
      maxTokens: 1_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });
    const fixture = requireDefined(heldOutScopeFixtures[0], 'fixture');
    const { bundle } = materializeHeldOutScopeFixture(fixture);
    const claim = requireDefined(bundle.candidates[0], 'claim');
    const systems: string[] = [];
    const transport: StructuredTransport = (input) => {
      const prompt = parsePrompt(input.prompt);
      const candidate = requireDefined(prompt.candidates[0], 'candidate');

      expect(candidate.scope).toEqual({
        product: 'LumenDB',
        generation: null,
        version: null,
        applicableAt: '2026-09-01T00:00:00.000Z',
      });
      expect(candidate.occurrences[0]?.capturedAt).toBe(
        '2026-09-01T00:00:00.000Z',
      );
      expect(prompt.sources[0]?.passages[0]?.text).toBe(fixture.passages[0]);
      systems.push(input.system ?? '');

      return Promise.resolve({
        output: input.schema.parse({
          assessments: [
            {
              claimId: claim.id,
              verdict: 'unresolved',
              reason: 'product_ambiguous',
              references: [],
              explanation: 'The selected generation is unknown.',
            },
          ],
        }),
        usage: { costUsd: 0 },
      });
    };

    for (const adjudicationRole of [v1Role, v2Role]) {
      const model = createGatewayGroundingModel({
        researchRole: profile.roles.research,
        adjudicationRole,
        accounting,
        transport,
      });

      await model.adjudicate(bundle, new AbortController().signal);

      expect(model.adjudication.promptVersion).toBe(
        adjudicationRole.promptVersion,
      );
    }

    expect(systems[0]).not.toContain('A null scope.generation');
    expect(systems[1]).toContain('A null scope.generation or scope.version');
    expect(systems[1]).toContain('product_ambiguous');
    expect(systems[1]).toContain('across all plausible generations/versions');
    expect(systems[1]).toContain('capturedAt, applicableAt or the review date');
  });

  it('should keep held-out cases separate and preserve scoped, universal and ambiguous controls', () => {
    expect(heldOutScopeFixtures).toHaveLength(8);
    expect(
      new Set(heldOutScopeFixtures.map((fixture) => fixture.product)),
    ).toHaveLength(3);
    expect(
      heldOutScopeFixtures.filter(
        (fixture) => fixture.expected === 'supported',
      ),
    ).toHaveLength(2);
    expect(
      heldOutScopeFixtures.filter(
        (fixture) => fixture.expected === 'contradicted',
      ),
    ).toHaveLength(2);
    for (const fixture of heldOutScopeFixtures) {
      expect(
        groundingEvaluationFixtures.some((gold) => gold.id === fixture.id),
      ).toBe(false);

      const { bundle, answers } = materializeHeldOutScopeFixture(fixture);

      validateGroundingBundle(bundle, { ...bundle.configIdentity, answers });

      expect(bundle.candidates[0]?.scope).toMatchObject({
        product: fixture.product,
        generation: fixture.generation,
        version: fixture.version,
      });
      expect(JSON.stringify({ bundle, answers })).not.toContain(fixture.id);
    }
  });
});

// Level 1 tests for the gateway grounding model: a mocked transport stands
// in for the gateway, and the assertions are about what the controller can
// observe from `decide` and `adjudicate`.
describe('model - createGatewayGroundingModel()', () => {
  const profile = testModelProfileFixture();
  const usage = { costUsd: 0.01, inputTokens: 10, outputTokens: 10 };
  const accounting = () => {
    return createMemoryModelAccounting({
      maxUsd: 10,
      maxTokens: 1_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });
  };
  /** Two selected claims and one overflow claim over one retained source. */
  const bundleFixture = () => {
    const {
      digest: _digest,
      sourceBundleDigest: _sourceBundleDigest,
      ...base
    } = groundingFixture();
    const retirement = requireDefined(base.candidates[0], 'retirement');

    return createGroundingBundle({
      ...base,
      assessments: [],
      adjudication: null,
      candidates: [
        retirement,
        {
          ...retirement,
          id: 'shutdown',
          proposition: 'Legacy edition shut down on July 20, 2026.',
          priority: 1,
        },
        {
          ...retirement,
          id: 'overflow-claim',
          proposition: 'Legacy edition offered a migration guide.',
          disposition: 'overflow',
          priority: 2,
        },
      ],
      coverage: {
        ...base.coverage,
        selectedCandidates: 2,
        overflowCandidates: 1,
      },
    });
  };
  const unresolved = (claimId: string) => {
    return {
      claimId,
      verdict: 'unresolved' as const,
      references: [],
      reason: 'not_in_sources' as const,
      explanation: 'The supplied source does not establish the claim.',
    };
  };
  const askedClaimIds = (prompt: string): string[] => {
    return parsePrompt(prompt).candidates.map((candidate) => candidate.id);
  };

  it('should fill a claim the provider never assessed as unresolved and drop an assessment naming a non-selected claim', async () => {
    // Only the stored v1 wire contract lets a provider name a claim outside
    // the request; v2 constrains the schema to the claims asked for.
    const legacyRole = {
      ...profile.roles.adjudication,
      schemaVersion: 'adjudication-v1',
    };
    const asked: string[][] = [];
    const transport: StructuredTransport = (input) => {
      asked.push(askedClaimIds(input.prompt));

      return Promise.resolve({
        output: input.schema.parse({
          assessments:
            asked.length === 1
              ? [unresolved('overflow-claim'), unresolved('retirement')]
              : [],
        }),
        usage,
      });
    };
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: legacyRole,
      accounting: accounting(),
      transport,
    });

    const assessments = await model.adjudicate(
      bundleFixture(),
      new AbortController().signal,
    );

    // The skipped claim is asked for again on its own; a round that adds
    // nothing ends the attempt and the gap is recorded, not invented.
    expect(asked).toEqual([['retirement', 'shutdown'], ['shutdown']]);
    expect(assessments).toEqual([
      unresolved('retirement'),
      expect.objectContaining({
        claimId: 'shutdown',
        verdict: 'unresolved',
        reason: 'provider_unavailable',
        references: [],
      }),
    ]);
  });

  it('should refuse before reserving when the selected claims alone exceed the input ceiling', async () => {
    const ledger = accounting();
    const transport = vi.fn(() =>
      Promise.reject(new Error('Unexpected dispatch over the input ceiling.')),
    );
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: { ...profile.roles.adjudication, maxInputTokens: 100 },
      accounting: ledger,
      transport,
    });

    const error = await model
      .adjudicate(bundleFixture(), new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^model_input_limit:/);
    // A plain error, not an integrity failure: the controller records the
    // selected claims as unresolved rather than aborting the run.
    expect((error as Error).name).toBe('Error');
    expect(error).not.toBeInstanceOf(ModelBudgetError);
    expect(error).not.toBeInstanceOf(GroundingIntegrityError);
    expect(transport).not.toHaveBeenCalled();
    expect(Object.keys(ledger.state.calls)).toHaveLength(0);
  });

  const decisionInput = (): GroundingDecisionInput => {
    const bundle = bundleFixture();
    const source = requireDefined(bundle.sources[0], 'source');

    return {
      candidates: bundle.candidates.filter(
        (candidate) => candidate.disposition === 'selected',
      ),
      sources: bundle.sources,
      allowedUrls: ['https://example.com/legacy'],
      publicSearchTerms: ['Example', 'example.com'],
      previousResults: [
        {
          kind: 'fetch',
          source,
          links: ['https://example.com/legacy/migration'],
          requestCount: 1,
        },
      ],
      remaining: { decisions: 5, searches: 2, documents: 3, elapsedMs: 60_000 },
    };
  };

  it('should decide a legal research action over a bounded view of the session', async () => {
    const finish: ResearchAction = {
      tool: 'finish_research',
      reason: 'evidence_ready',
      relevance: 'The announcement is retained in the fetched source.',
    };
    const prompts: string[] = [];
    const transport: StructuredTransport = (input) => {
      prompts.push(input.prompt);

      return Promise.resolve({ output: input.schema.parse(finish), usage });
    };
    const ledger = accounting();
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: profile.roles.adjudication,
      accounting: ledger,
      transport,
    });

    const action = await model.decide(
      decisionInput(),
      new AbortController().signal,
    );

    // The controller re-parses every decision; a legal one survives intact.
    expect(researchActionSchema.parse(action)).toEqual(finish);

    const view = parsePrompt(requireDefined(prompts[0], 'prompt'));

    expect(view.candidates.map((candidate) => candidate.id)).toEqual([
      'retirement',
      'shutdown',
    ]);
    // A fetched page is referenced by id; its body never travels twice.
    expect(view.previousResults).toEqual([
      {
        kind: 'fetch',
        sourceId: 'source-1',
        links: ['https://example.com/legacy/migration'],
      },
    ]);
    // Search vocabulary is tokenised public terms, never raw answer text.
    expect(view.publicSearchTerms).toEqual(
      expect.arrayContaining(['example', 'com']),
    );
    expect(view.publicSearchTerms).not.toContain('example.com');
    expect(Object.values(ledger.state.calls)).toHaveLength(1);
  });

  it('should surface a decision schema miss as the billed schema failure the controller stops on, not an integrity error', async () => {
    const miss = new StructuredOutputMissingError(
      {
        text: 'Prose instead of the requested action.',
        usage: { ...usage, finishReason: 'stop' },
        issues: [{ path: 'tool', message: 'Invalid discriminator value' }],
      },
      {
        cause: new Error('No object generated: response did not match schema.'),
      },
    );
    const ledger = accounting();
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: profile.roles.adjudication,
      accounting: ledger,
      transport: () => Promise.reject(miss),
    });

    const result = model.decide(decisionInput(), new AbortController().signal);

    await expect(result).rejects.toBe(miss);
    expect(structuredFailureDiagnostic(miss).classification).toBe('schema');
    // Not a ZodError, budget or integrity failure: the controller maps it to
    // a provider_unavailable stop for the session instead of aborting.
    expect(miss.name).not.toBe('ZodError');
    expect(miss).not.toBeInstanceOf(ModelBudgetError);
    expect(miss).not.toBeInstanceOf(GroundingIntegrityError);
    // The provider answered and billed, so the call is settled as invalid
    // at its reported cost rather than left at the reservation estimate.
    const calls = Object.values(ledger.state.calls);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.usage).toMatchObject({
      valid: false,
      costUsd: usage.costUsd,
      finishReason: 'stop',
    });
  });
});
