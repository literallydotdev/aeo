import { describe, expect, it } from 'vitest';
import { testModelProfileFixture } from '../models/profile-fixture';
import { createMemoryModelAccounting } from '../models/accounting';
import { internalModelRoleDigest } from '../models/profiles';
import type { StructuredTransport } from '../models/structured';
import { structuredWireSchema } from '../models/wire-schema';
import { requireDefined } from '../__fixtures__/require-defined';
import {
  groundingEvaluationFixtures,
  materializeEvaluationFixture,
} from './evaluation-fixtures';
import { createGatewayGroundingModel } from './model';
import { createGroundingBundle } from './validation';

const selectedId = 'claim_c7c15e4893a9e17f54650a6448df6b34';
const otherId = 'claim_0123456789abcdef0123456789abcdef';
const overflowId = 'claim_abcdef0123456789abcdef0123456789';
const corruptedId =
  'claim_c7c15e4893a9e17f54650a6448df792bfe01d84b744d72336ecffe3f4ddce897';

const fixture = () => {
  const profile = testModelProfileFixture();
  const { bundle: original } = materializeEvaluationFixture(
    requireDefined(groundingEvaluationFixtures[0], 'first fixture'),
  );
  const claim = requireDefined(original.candidates[0], 'claim');
  const bundle = createGroundingBundle({
    ...original,
    candidates: [selectedId, otherId, overflowId].map((id) => ({
      ...claim,
      id,
      disposition:
        id === overflowId ? ('overflow' as const) : ('selected' as const),
    })),
    coverage: {
      ...original.coverage,
      selectedCandidates: 2,
      overflowCandidates: 1,
    },
  });
  const accounting = createMemoryModelAccounting({
    maxUsd: 10,
    maxTokens: 1_000_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });

  return { profile, bundle, accounting };
};

const unresolved = (claimId: string) => {
  return {
    claimId,
    verdict: 'unresolved',
    references: [],
    reason: 'not_in_sources',
    explanation: 'The supplied source does not establish the claim.',
  };
};

const claimIdEnums = (value: unknown): unknown[] => {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const object = value as Record<string, unknown>;
  const properties = object.properties as
    Record<string, { enum?: unknown } | undefined> | undefined;

  return [
    ...(properties?.claimId?.enum ? [properties.claimId.enum] : []),
    ...Object.values(object).flatMap(claimIdEnums),
  ];
};

describe('model - adjudication selected-ID wire contract', () => {
  it('should reject unknown pinned schema versions before any model work', () => {
    const { profile, accounting } = fixture();

    const create = () => {
      return createGatewayGroundingModel({
        researchRole: profile.roles.research,
        adjudicationRole: {
          ...profile.roles.adjudication,
          schemaVersion: 'adjudication-v999',
        },
        accounting,
      });
    };

    expect(create).toThrow('adjudication-v2');
    expect(Object.keys(accounting.state.calls)).toHaveLength(0);
  });

  it('should constrain every verdict branch to selected IDs, excluding corrupted and valid-looking unselected IDs', async () => {
    const { profile, bundle, accounting } = fixture();
    const transport: StructuredTransport = async (input) => {
      expect(claimIdEnums(structuredWireSchema(input.schema).wire)).toEqual([
        [selectedId, otherId],
        [selectedId, otherId],
        [selectedId, otherId],
      ]);

      for (const claimId of [corruptedId, overflowId]) {
        const common = {
          claimId,
          explanation: 'A schema-contract fixture.',
          references: [{ sourceId: 'source', passageId: 'passage' }],
        };

        for (const assessment of [
          unresolved(claimId),
          { ...common, verdict: 'supported' },
          {
            ...common,
            verdict: 'contradicted',
            incompatibleProposition: 'An incompatible fixture proposition.',
          },
        ]) {
          expect(
            input.schema.safeParse({ assessments: [assessment] }).success,
          ).toBe(false);
        }
      }

      return Promise.resolve({
        output: input.schema.parse({
          assessments: [unresolved(otherId), unresolved(selectedId)],
        }),
        usage: { costUsd: 0 },
      });
    };
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: profile.roles.adjudication,
      accounting,
      transport,
    });

    const assessments = await model.adjudicate(
      bundle,
      new AbortController().signal,
    );

    // Assessments come back in selected order, whatever order the provider
    // answered in, so the frozen artifact does not depend on it.
    expect(assessments.map((a) => a.claimId)).toEqual([selectedId, otherId]);
  });

  it('should preserve stored v1 profiles and their wire contract without changing their identity', async () => {
    const { profile, bundle, accounting } = fixture();
    const current = profile.roles.adjudication;
    const legacy = { ...current, schemaVersion: 'adjudication-v1' };
    const stored = JSON.stringify(legacy);

    expect(current.schemaVersion).toBe('adjudication-v2');
    expect(internalModelRoleDigest(current)).not.toBe(
      internalModelRoleDigest(legacy),
    );

    const transport: StructuredTransport = (input) => {
      expect(input.role).toEqual(legacy);
      expect(claimIdEnums(structuredWireSchema(input.schema).wire)).toEqual([]);

      return Promise.resolve({
        output: input.schema.parse({
          assessments: [unresolved(selectedId), unresolved(otherId)],
        }),
        usage: { costUsd: 0 },
      });
    };
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: legacy,
      accounting,
      transport,
    });

    await model.adjudicate(bundle, new AbortController().signal);

    expect(model.adjudication.profileDigest).toBe(
      internalModelRoleDigest(legacy),
    );
    expect(JSON.stringify(legacy)).toBe(stored);
  });

  it('should make no reservation or dispatch when there are no selected claims', async () => {
    const { profile, bundle, accounting } = fixture();
    for (const candidate of bundle.candidates) {
      candidate.disposition = 'overflow';
    }

    const transport: StructuredTransport = () => {
      return Promise.reject(new Error('Unexpected dispatch.'));
    };
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: profile.roles.adjudication,
      accounting,
      transport,
    });

    const assessments = await model.adjudicate(
      bundle,
      new AbortController().signal,
    );

    expect(assessments).toEqual([]);
    expect(Object.keys(accounting.state.calls)).toHaveLength(0);
  });

  it('should ask again for the claims a response skipped, constrained to exactly those claims, and merges in selected order', async () => {
    const { profile, bundle, accounting } = fixture();
    const enums: unknown[][] = [];
    const transport: StructuredTransport = (input) => {
      enums.push(
        claimIdEnums(structuredWireSchema(input.schema).wire)[0] as unknown[],
      );

      const first = enums.length === 1;

      return Promise.resolve({
        output: input.schema.parse({
          assessments: first
            ? [unresolved(otherId), unresolved(otherId)]
            : [unresolved(selectedId)],
        }),
        usage: { costUsd: 0 },
      });
    };
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: profile.roles.adjudication,
      accounting,
      transport,
    });

    const assessments = await model.adjudicate(
      bundle,
      new AbortController().signal,
    );

    // Duplicates dropped, the retry's answer merged, selected order kept.
    expect(assessments.map((a) => a.claimId)).toEqual([selectedId, otherId]);
    expect(enums).toEqual([[selectedId, otherId], [selectedId]]);
  });

  it('should record a claim the provider never assessed as unresolved once a round adds nothing', async () => {
    const { profile, bundle, accounting } = fixture();
    let calls = 0;
    const transport: StructuredTransport = (input) => {
      calls += 1;

      // The retry is constrained to the skipped claim, which the provider
      // skips again; that round adds nothing and ends the attempt.
      return Promise.resolve({
        output: input.schema.parse({
          assessments: calls === 1 ? [unresolved(otherId)] : [],
        }),
        usage: { costUsd: 0 },
      });
    };
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: profile.roles.adjudication,
      accounting,
      transport,
    });

    const assessments = await model.adjudicate(
      bundle,
      new AbortController().signal,
    );

    expect(calls).toBe(2);
    expect(assessments).toEqual([
      expect.objectContaining({
        claimId: selectedId,
        verdict: 'unresolved',
        reason: 'provider_unavailable',
      }),
      unresolved(otherId),
    ]);
  });

  it('should stop at the attempt bound even while every round adds a verdict', async () => {
    const { profile, bundle: base, accounting } = fixture();
    const ids = ['a', 'b', 'c', 'd'].map(
      (letter) => `claim_${letter.repeat(32)}`,
    );
    const claim = requireDefined(base.candidates[0], 'claim');
    const bundle = createGroundingBundle({
      ...base,
      candidates: ids.map((id) => ({
        ...claim,
        id,
        disposition: 'selected' as const,
      })),
      coverage: {
        ...base.coverage,
        selectedCandidates: 4,
        overflowCandidates: 0,
      },
    });
    let calls = 0;
    // One verdict per call, always for the first claim still asked about.
    const transport: StructuredTransport = (input) => {
      calls += 1;

      const [asked] = claimIdEnums(
        structuredWireSchema(input.schema).wire,
      )[0] as string[];

      return Promise.resolve({
        output: input.schema.parse({
          assessments: [unresolved(requireDefined(asked, 'asked claim'))],
        }),
        usage: { costUsd: 0 },
      });
    };
    const model = createGatewayGroundingModel({
      researchRole: profile.roles.research,
      adjudicationRole: profile.roles.adjudication,
      accounting,
      transport,
    });

    const assessments = await model.adjudicate(
      bundle,
      new AbortController().signal,
    );

    expect(calls).toBe(3);
    expect(assessments.map((assessment) => assessment.claimId)).toEqual(ids);
    expect(
      assessments.map((assessment) =>
        assessment.verdict === 'unresolved' ? assessment.reason : null,
      ),
    ).toEqual([
      'not_in_sources',
      'not_in_sources',
      'not_in_sources',
      'provider_unavailable',
    ]);
  });
});
