import { buildCandidateInventory } from './extract';
import {
  materializeEvaluationFixture,
  type GroundingEvaluationFixture,
} from './evaluation-fixtures';
import { createGroundingBundle } from './validation';

export type HeldOutScopeFixture = Omit<
  GroundingEvaluationFixture,
  'group' | 'generation'
> & {
  product: string;
  generation: string | null;
  version: string | null;
};

// Authored after comparison v1 exposed an unknown-generation error, before any
// model has seen these cases. Separate from the 40-case gold set and its gates.
// Synthetic evidence and agent-authored labels still require human review.
export const heldOutScopeFixtures: readonly HeldOutScopeFixture[] = [
  {
    id: 'lumen-export-generation',
    product: 'LumenDB',
    generation: null,
    version: null,
    expected: 'unresolved',
    claim: 'LumenDB exports snapshots as CSV files.',
    passages: [
      'As of September 1, 2026, LumenDB Archive and LumenDB Stream are both available. Archive exports snapshots as CSV files. Stream exports snapshots only as Parquet files and cannot export CSV.',
    ],
    rationale:
      'Both generations exist at capture time; an unspecified generation cannot be assumed to mean Stream.',
  },
  {
    id: 'quartz-protocol-version',
    product: 'QuartzQueue',
    generation: 'Hosted',
    version: null,
    expected: 'unresolved',
    claim: 'QuartzQueue Hosted clients use protocol Q1.',
    passages: [
      'As of September 1, 2026, QuartzQueue Hosted releases 3 and 4 remain supported. Release 3 clients use protocol Q1. Release 4 clients must use protocol Q2 and cannot use Q1.',
    ],
    rationale:
      'A known hosted generation and capture date do not identify release 3 or 4.',
  },
  {
    id: 'orchid-recent-answer',
    product: 'OrchidSearch',
    generation: null,
    version: null,
    expected: 'unresolved',
    claim: 'OrchidSearch requires indexes to fit in memory.',
    passages: [
      'On September 1, 2026, OrchidSearch Cedar and the newer OrchidSearch Birch are both sold. Cedar requires indexes to fit in memory. Birch supports disk-backed indexes larger than memory.',
    ],
    rationale:
      'The newer product is not implied by a contemporary answer timestamp.',
  },
  {
    id: 'lumen-cross-generation-support',
    product: 'LumenDB',
    generation: null,
    version: null,
    expected: 'supported',
    claim: 'LumenDB encrypts stored snapshots.',
    passages: [
      'LumenDB Archive and Stream are the only LumenDB generations. Both encrypt every stored snapshot, across all versions, as of September 1, 2026.',
    ],
    rationale:
      'Support covers every plausible generation and version; unknown generation does not require abstention.',
  },
  {
    id: 'quartz-cross-version-contradiction',
    product: 'QuartzQueue',
    generation: 'Hosted',
    version: null,
    expected: 'contradicted',
    claim: 'QuartzQueue Hosted permits messages larger than one megabyte.',
    passages: [
      'As of September 1, 2026, every released version of QuartzQueue Hosted rejects messages larger than one megabyte. There are no plan or version exceptions.',
    ],
    rationale:
      'The incompatible proposition is explicitly valid across all versions.',
  },
  {
    id: 'lumen-explicit-archive',
    product: 'LumenDB',
    generation: 'Archive',
    version: null,
    expected: 'supported',
    claim: 'LumenDB Archive exports snapshots as CSV files.',
    passages: [
      'On September 1, 2026, all LumenDB Archive versions export snapshots as CSV files. The separate LumenDB Stream generation exports only Parquet.',
    ],
    rationale:
      'Explicit Archive scope settles generation; another generation does not make this claim ambiguous.',
  },
  {
    id: 'quartz-explicit-release',
    product: 'QuartzQueue',
    generation: 'Hosted',
    version: '4',
    expected: 'contradicted',
    claim: 'QuartzQueue Hosted release 4 clients use protocol Q1.',
    passages: [
      'On September 1, 2026, QuartzQueue Hosted release 3 uses Q1. Release 4 requires Q2 and cannot use Q1.',
    ],
    rationale:
      'An explicitly specified release permits a precise contradiction.',
  },
  {
    id: 'orchid-incomplete-generation-coverage',
    product: 'OrchidSearch',
    generation: null,
    version: null,
    expected: 'unresolved',
    claim: 'OrchidSearch provides daily index backups.',
    passages: [
      'As of September 1, 2026, OrchidSearch Cedar and Birch are available. Every Birch version provides daily index backups. This document does not describe backups for Cedar.',
    ],
    rationale:
      'One generation has supporting evidence and the other has no coverage; there is neither universal support nor contradiction.',
  },
];

export const materializeHeldOutScopeFixture = (
  fixture: HeldOutScopeFixture,
) => {
  const { bundle, answers } = materializeEvaluationFixture({
    ...fixture,
    group: 'edge',
  });

  const [answer] = answers;
  const [candidate] = bundle.candidates;

  if (!answer || !candidate) {
    throw new Error(
      `Held-out scope fixture did not materialize an answer and claim: ${fixture.id}.`,
    );
  }

  const candidates = buildCandidateInventory(
    [
      {
        answerId: answer.id,
        proposition: fixture.claim,
        quote: fixture.claim,
        scope: {
          ...candidate.scope,
          product: fixture.product,
          generation: fixture.generation,
          version: fixture.version,
        },
        category: 'capability',
        inAuditedProductScope: true,
      },
    ],
    answers,
  );

  return {
    bundle: createGroundingBundle({ ...bundle, candidates }),
    answers,
  };
};
