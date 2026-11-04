import type { GroundingBundle } from '../../grounding/schema';
import {
  assessmentDigest,
  createGroundingBundle,
  groundingDigest,
} from '../../grounding/validation';
import { contentHash } from '../../stores/content-hash';

type FixtureVerdict = 'supported' | 'contradicted' | 'unresolved';

type AssessmentBase = {
  claimId: string;
  scope: {
    product: string;
    generation: string;
    version: null;
    applicableAt: string;
  };
  explanation: string;
  sourceBundleDigest: string;
  digest: string;
  references: { sourceId: string; passageId: string }[];
};

const createAssessment = (verdict: FixtureVerdict, base: AssessmentBase) => {
  switch (verdict) {
    case 'unresolved': {
      return { ...base, verdict, reason: 'not_in_sources' as const };
    }
    case 'contradicted': {
      return {
        ...base,
        verdict,
        incompatibleProposition:
          'Legacy edition retirement was announced for another date.',
      };
    }
    case 'supported': {
      return { ...base, verdict };
    }
    default: {
      const unhandled: never = verdict;

      throw new Error(`Unhandled fixture verdict: ${String(unhandled)}.`);
    }
  }
};

export type GroundingFixtureOptions = {
  reportKey?: string;
  runId?: string;
  configVersion?: number;
  verdict?: FixtureVerdict;
};

export const groundingFixture = ({
  reportKey = 'synthetic',
  runId = 'run-1',
  configVersion = 1,
  verdict = 'supported',
}: GroundingFixtureOptions = {}): GroundingBundle => {
  const text =
    'Example announced that Legacy edition would retire on July 20, 2026. This announcement does not establish whether the shutdown happened.';
  const scope = {
    product: 'Example',
    generation: 'Legacy edition',
    version: null,
    applicableAt: '2026-09-08T12:00:00.000Z',
  };
  const empty = createGroundingBundle({
    schemaVersion: 1,
    policyVersion: 1,
    configIdentity: { reportKey, configVersion },
    runId,
    reviewAsOf: '2026-09-08T12:00:00.000Z',
    sources: [
      {
        id: 'source-1',
        requestedUrl: 'https://example.com/legacy',
        finalUrl: 'https://example.com/legacy',
        title: 'Legacy edition announcement',
        publisher: 'Example',
        provenance: 'first_party',
        fetchedAt: '2026-09-08T12:00:00.000Z',
        sourceDate: null,
        documentDigest: contentHash(text),
        retainedDigest: contentHash([text]),
        passages: [{ id: 'passage-1', text, digest: contentHash(text) }],
        extractionVersion: 1,
        truncated: false,
      },
    ],
    facts: [],
    candidates: [
      {
        id: 'retirement',
        proposition:
          'Legacy edition retirement was announced for July 20, 2026.',
        scope,
        category: 'lifecycle',
        occurrences: [
          {
            answerId: 'answer-1',
            runId,
            section: 'first',
            promptId: 'p0',
            surface: 'gemini',
            runIndex: 1,
            capturedAt: '2026-09-08T12:00:00.000Z',
            answerDigest: contentHash(text),
            start: 0,
            end: text.length,
            quote: text,
          },
        ],
        disposition: 'selected',
        duplicateOf: null,
        priority: 0,
      },
    ],
    assessments: [],
    coverage: {
      suppliedAnswers: 1,
      extractedAnswers: 1,
      truncatedAnswers: 0,
      selectedCandidates: 1,
      overflowCandidates: 0,
      stopReason: 'evidence_ready',
      retrievals: [],
      gaps: [],
    },
    adjudication: null,
  });

  const base = {
    claimId: 'retirement',
    scope,
    explanation: 'Keep the announcement and completion of shutdown distinct.',
    sourceBundleDigest: empty.sourceBundleDigest,
    digest: '',
    references: [{ sourceId: 'source-1', passageId: 'passage-1' }],
  };
  const draftAssessment = createAssessment(verdict, base);
  const assessment = {
    ...draftAssessment,
    digest: assessmentDigest(draftAssessment),
  };

  const bundle = {
    ...empty,
    assessments: [assessment],
    adjudication: {
      model: 'anthropic/claude-opus-4.6',
      profileDigest: contentHash('fixture-profile'),
      promptVersion: 'adjudication-grounding-v1',
      policyVersion: 1 as const,
    },
  };

  return { ...bundle, digest: groundingDigest(bundle) };
};

export const measurementGroundingFixture = (
  reportKey: string,
  runId: string,
  { configVersion = 1 }: { configVersion?: number } = {},
): GroundingBundle => {
  const source = groundingFixture({ reportKey, runId, configVersion });

  const {
    digest: _digest,
    sourceBundleDigest: _sourceBundleDigest,
    ...base
  } = source;

  return createGroundingBundle({
    ...base,
    sources: [],
    candidates: [],
    assessments: [],
    adjudication: null,
    coverage: {
      ...base.coverage,
      suppliedAnswers: 0,
      extractedAnswers: 0,
      selectedCandidates: 0,
    },
  });
};
