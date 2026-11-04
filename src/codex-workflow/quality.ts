import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { maxReviewRounds, type AeoSnapshot } from '../schema';

export type ReportQuality = NonNullable<AeoSnapshot['meta']['quality']>;
export { maxReviewRounds };

// OUT/review.json is host-written after validation, but a work directory
// can outlive a review schema change. Only the fields read from it are
// checked, and loosely, so an older file still yields its scorecard.
const storedReviewSchema = z.looseObject({
  criteria: z.array(
    z.looseObject({ criterionId: z.string(), outcome: z.string() }),
  ),
  unresolved: z.array(
    z.looseObject({
      criterionId: z.string(),
      stage: z.string(),
      file: z.string().nullable(),
      problem: z.string(),
      evidence: z.string(),
    }),
  ),
});

export type StoredReview = z.infer<typeof storedReviewSchema>;

export const readStoredReview = async (
  dir: string,
): Promise<StoredReview | null> => {
  const raw =
    (await readFile(path.join(dir, 'OUT', 'review.json'), 'utf8').catch(
      () => 'null',
    )) || 'null';
  const review = storedReviewSchema.nullable().parse(JSON.parse(raw));

  return review;
};

export type ReportQualityOptions = {
  rounds: number;
  degraded: readonly string[];
  accepted: boolean;
};

export const reportQuality = async (
  dir: string,
  { rounds, degraded, accepted }: ReportQualityOptions,
): Promise<ReportQuality> => {
  const review = await readStoredReview(dir);
  const issues: ReportQuality['issues'] = [
    ...(review?.unresolved ?? []).map((issue) => ({
      stage: issue.stage,
      code: issue.criterionId,
      message: issue.problem,
      file: issue.file,
      evidence: issue.evidence,
    })),
    ...(review?.criteria ?? [])
      .filter(
        (criterion) =>
          criterion.outcome === 'fail' &&
          !review?.unresolved.some(
            (issue) => issue.criterionId === criterion.criterionId,
          ),
      )
      .map((criterion) => ({
        stage: 'review',
        code: criterion.criterionId,
        message: 'Review criterion remains unresolved.',
      })),
    ...degraded.map((file) => ({
      stage: 'analysis',
      code: 'unjudged_answer',
      message: 'Captured answer retained without a validated judgment.',
      file,
    })),
  ];

  if (!accepted && !issues.length) {
    issues.push({
      stage: 'review',
      code: 'review_incomplete',
      message:
        'Review did not confirm all criteria within the available rounds.',
    });
  }

  const quality = {
    needsImprovement: issues.length > 0,
    reviewRounds: Math.min(rounds, maxReviewRounds),
    issues,
  };

  return quality;
};
