import { contentHash } from '../stores/content-hash';
import { validateResearchUrl } from './fetch';
import {
  groundingBundleSchema,
  type GroundingBundle,
  type ClaimAssessment,
  type ClaimCandidate,
  type SavedAnswer,
  type SourceReference,
} from './schema';

export class GroundingIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GroundingIntegrityError';
  }
}

const requireIntegrity: (
  condition: unknown,
  message: string,
) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new GroundingIntegrityError(message);
  }
};

type DistributiveOmit<T, TKey extends PropertyKey> = T extends unknown
  ? Omit<T, TKey>
  : never;

export const assessmentDigest = (
  assessment: DistributiveOmit<ClaimAssessment, 'digest'> | ClaimAssessment,
): string => {
  const { digest: _digest, ...value } = { digest: undefined, ...assessment };

  return contentHash(value);
};

export const sourceBundleDigest = (
  bundle:
    Omit<GroundingBundle, 'digest' | 'sourceBundleDigest'> | GroundingBundle,
): string => {
  const {
    sources,
    candidates,
    coverage,
    configIdentity,
    runId,
    reviewAsOf,
    schemaVersion,
    policyVersion,
  } = bundle;
  // Product facts are adjudication outputs. The complete bundle digest additionally
  // binds those facts and verdicts; this digest pins the pre-adjudication evidence.
  return contentHash({
    sources,
    candidates,
    coverage,
    configIdentity,
    runId,
    reviewAsOf,
    schemaVersion,
    policyVersion,
  });
};

export const groundingDigest = (
  bundle: Omit<GroundingBundle, 'digest'> | GroundingBundle,
): string => {
  const { digest: _digest, ...value } = { digest: undefined, ...bundle };

  return contentHash(value);
};

/**
 * adjudicationEvidenceDigest keys what an adjudication judges: the retained
 * sources and the claims under the bundle's review identity, by the
 * adjudicator that judges them. The coverage bookkeeping beside them is deliberately outside it: why research
 * stopped and which retrievals ran change from one revision to the next
 * without changing the evidence, and a repair revision that gathered
 * nothing new reuses the completed verdicts over identical evidence instead
 * of paying for the same judgement again. The source bundle digest keeps
 * binding coverage; this one only keys the adjudication.
 */
export const adjudicationEvidenceDigest = (
  bundle: Pick<
    GroundingBundle,
    | 'sources'
    | 'candidates'
    | 'configIdentity'
    | 'runId'
    | 'reviewAsOf'
    | 'schemaVersion'
    | 'policyVersion'
  >,
  adjudication: NonNullable<GroundingBundle['adjudication']>,
): string => {
  const {
    sources,
    candidates,
    configIdentity,
    runId,
    reviewAsOf,
    schemaVersion,
    policyVersion,
  } = bundle;
  return contentHash({
    sources,
    candidates,
    configIdentity,
    runId,
    reviewAsOf,
    schemaVersion,
    policyVersion,
    adjudication,
  });
};

export const assertSourceReferences = (
  references: readonly SourceReference[],
  bundle: Pick<GroundingBundle, 'sources'>,
): void => {
  for (const reference of references) {
    requireIntegrity(
      bundle.sources.some(
        (source) =>
          source.id === reference.sourceId &&
          source.passages.some((passage) => passage.id === reference.passageId),
      ),
      `Unknown source passage reference: ${reference.sourceId}/${reference.passageId}.`,
    );
  }
};

export const validateCandidateOccurrences = (
  candidate: ClaimCandidate,
  answers: readonly SavedAnswer[],
): void => {
  for (const occurrence of candidate.occurrences) {
    const answer = answers.find((item) => item.id === occurrence.answerId);

    requireIntegrity(
      answer,
      `Claim references an unknown answer: ${candidate.id}.`,
    );

    requireIntegrity(
      answer.digest === contentHash(answer.text) &&
        occurrence.answerDigest === answer.digest,
      `Claim answer digest mismatch for answer: ${answer.id}.`,
    );

    requireIntegrity(
      answer.runId === occurrence.runId &&
        answer.section === occurrence.section &&
        answer.promptId === occurrence.promptId &&
        answer.surface === occurrence.surface &&
        answer.runIndex === occurrence.runIndex &&
        answer.capturedAt === occurrence.capturedAt,
      `Claim answer identity mismatch for answer: ${answer.id}.`,
    );

    requireIntegrity(
      occurrence.end <= answer.text.length &&
        answer.text.slice(occurrence.start, occurrence.end) ===
          occurrence.quote,
      `Claim answer span mismatch for answer: ${answer.id}.`,
    );
  }
};

type ExpectedGroundingIdentity = {
  reportKey: string;
  configVersion?: number;
  runId?: string;
  digest?: string;
  answers?: readonly SavedAnswer[];
};

const validateExpectedIdentity = (
  bundle: GroundingBundle,
  expected: ExpectedGroundingIdentity,
): void => {
  requireIntegrity(
    bundle.configIdentity.reportKey === expected.reportKey,
    `Grounding report mismatch: ${bundle.configIdentity.reportKey}.`,
  );

  if (expected.configVersion !== undefined) {
    requireIntegrity(
      bundle.configIdentity.configVersion === expected.configVersion,
      `Grounding config version mismatch: ${bundle.configIdentity.configVersion}.`,
    );
  }

  if (expected.runId !== undefined) {
    requireIntegrity(
      bundle.runId === expected.runId,
      `Grounding run mismatch: ${String(bundle.runId)}.`,
    );
  }

  if (expected.digest !== undefined) {
    requireIntegrity(
      bundle.digest === expected.digest,
      `Grounding receipt mismatch: ${bundle.digest}.`,
    );
  }
};

const validateSources = (bundle: GroundingBundle): void => {
  for (const source of bundle.sources) {
    validateResearchUrl(source.requestedUrl);
    validateResearchUrl(source.finalUrl);

    requireIntegrity(
      new Set(source.passages.map((passage) => passage.id)).size ===
        source.passages.length,
      `Duplicate passage IDs in source: ${source.id}.`,
    );

    requireIntegrity(
      source.retainedDigest ===
        contentHash(source.passages.map((passage) => passage.text)),
      `Retained source digest mismatch: ${source.id}.`,
    );

    requireIntegrity(
      Buffer.byteLength(
        source.passages.map((passage) => passage.text).join('\n'),
      ) <= 16_384,
      `Retained source exceeds limit: ${source.id}.`,
    );

    for (const passage of source.passages) {
      requireIntegrity(
        passage.digest === contentHash(passage.text),
        `Source passage digest mismatch: ${source.id}/${passage.id}.`,
      );
    }
  }
};

const isValidDisposition = (
  candidate: ClaimCandidate,
  candidates: readonly ClaimCandidate[],
): boolean => {
  if (candidate.disposition !== 'duplicate') {
    return candidate.duplicateOf === null;
  }

  const { duplicateOf } = candidate;

  if (!duplicateOf) {
    return false;
  }

  const isValid = candidates.some(
    (item) => item.id === duplicateOf && item.disposition === 'selected',
  );

  return isValid;
};

const validateCandidates = (
  bundle: GroundingBundle,
  answers: readonly SavedAnswer[] | undefined,
): void => {
  for (const candidate of bundle.candidates) {
    if (answers) {
      validateCandidateOccurrences(candidate, answers);
    }

    if (bundle.runId) {
      for (const occurrence of candidate.occurrences) {
        requireIntegrity(
          occurrence.runId === bundle.runId,
          `Cross-run candidate occurrence: ${candidate.id}.`,
        );
      }
    }

    requireIntegrity(
      isValidDisposition(candidate, bundle.candidates),
      `Invalid duplicate disposition: ${candidate.id}.`,
    );
  }
};

const validateAssessments = (bundle: GroundingBundle): void => {
  requireIntegrity(
    new Set(bundle.assessments.map((assessment) => assessment.claimId)).size ===
      bundle.assessments.length,
    'Duplicate claim assessments.',
  );

  for (const assessment of bundle.assessments) {
    const candidate = bundle.candidates.find(
      (item) => item.id === assessment.claimId,
    );

    requireIntegrity(
      candidate?.disposition === 'selected',
      `Assessment references an unselected candidate: ${assessment.claimId}.`,
    );

    requireIntegrity(
      contentHash(assessment.scope) === contentHash(candidate.scope),
      `Assessment changes claim scope: ${assessment.claimId}.`,
    );

    requireIntegrity(
      assessment.sourceBundleDigest === bundle.sourceBundleDigest &&
        assessment.digest === assessmentDigest(assessment),
      `Assessment digest mismatch: ${assessment.claimId}.`,
    );

    assertSourceReferences(assessment.references, bundle);

    if (
      assessment.verdict !== 'unresolved' &&
      candidate.occurrences.some((item) => !item.capturedAt)
    ) {
      requireIntegrity(
        candidate.scope.applicableAt !== null,
        `Undated claim requires unresolved temporal assessment: ${assessment.claimId}.`,
      );
    }
  }
};

const validateCoverage = (bundle: GroundingBundle): void => {
  const selectedCount = bundle.candidates.filter(
    (candidate) => candidate.disposition === 'selected',
  ).length;
  const overflowCount = bundle.candidates.filter(
    (candidate) => candidate.disposition === 'overflow',
  ).length;
  const expectedAssessmentCount = bundle.adjudication ? selectedCount : 0;

  requireIntegrity(
    bundle.assessments.length === expectedAssessmentCount,
    `Final adjudication must cover every selected claim: ${bundle.assessments.length} of ${expectedAssessmentCount}.`,
  );

  requireIntegrity(
    bundle.coverage.selectedCandidates === selectedCount,
    `Candidate coverage mismatch: ${bundle.coverage.selectedCandidates}.`,
  );

  requireIntegrity(
    bundle.coverage.overflowCandidates === overflowCount,
    `Candidate overflow mismatch: ${bundle.coverage.overflowCandidates}.`,
  );

  requireIntegrity(
    bundle.coverage.extractedAnswers <= bundle.coverage.suppliedAnswers &&
      bundle.coverage.truncatedAnswers <= bundle.coverage.suppliedAnswers,
    `Invalid answer coverage: ${bundle.coverage.suppliedAnswers} supplied answers.`,
  );

  const droppedByAnswer = (bundle.coverage.droppedClaimsByAnswer ?? []).reduce(
    (sum, entry) => sum + entry.claims,
    0,
  );

  requireIntegrity(
    (bundle.coverage.droppedClaims ?? 0) === droppedByAnswer,
    `Dropped claim coverage mismatch: ${String(bundle.coverage.droppedClaims)}.`,
  );
};

/**
 * validateGroundingBundle checks identity through hashes and references.
 * Semantic entailment remains a model and evaluation responsibility.
 */
export const validateGroundingBundle = (
  value: unknown,
  expected?: ExpectedGroundingIdentity,
): GroundingBundle => {
  const bundle = groundingBundleSchema.parse(value);

  requireIntegrity(
    bundle.digest === groundingDigest(bundle),
    `Grounding digest mismatch: ${bundle.digest}.`,
  );

  requireIntegrity(
    bundle.sourceBundleDigest === sourceBundleDigest(bundle),
    `Grounding source digest mismatch: ${bundle.sourceBundleDigest}.`,
  );

  if (expected) {
    validateExpectedIdentity(bundle, expected);
  }

  for (const collection of [bundle.sources, bundle.facts, bundle.candidates]) {
    requireIntegrity(
      new Set(collection.map((item) => item.id)).size === collection.length,
      'Duplicate grounding IDs.',
    );
  }

  validateSources(bundle);

  for (const fact of bundle.facts) {
    assertSourceReferences(fact.references, bundle);

    requireIntegrity(
      fact.status !== 'supported' || fact.references.length > 0,
      `Supported fact lacks sources: ${fact.id}.`,
    );
  }

  validateCandidates(bundle, expected?.answers);
  validateAssessments(bundle);
  validateCoverage(bundle);

  return bundle;
};

export const createGroundingBundle = (
  value: Omit<GroundingBundle, 'digest' | 'sourceBundleDigest'>,
): GroundingBundle => {
  const sourceDigest = sourceBundleDigest(value);
  const withSources = { ...value, sourceBundleDigest: sourceDigest };

  const bundle = validateGroundingBundle({
    ...withSources,
    digest: groundingDigest(withSources),
  });

  return bundle;
};
