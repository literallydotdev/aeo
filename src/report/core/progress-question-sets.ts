import type { ProgressMeasurement, ProgressSlot } from './progress-schema';

/** A question is its text within its section, wherever it appears in order. */
export const progressQuestionKey = (
  slot: Pick<ProgressSlot, 'sectionKey' | 'questionKey'>,
): string => {
  return JSON.stringify([slot.sectionKey, slot.questionKey]);
};

export const progressQuestionKeys = (
  point: Pick<ProgressMeasurement, 'slots'>,
): string[] => {
  return [...new Set(point.slots.map(progressQuestionKey))].sort();
};

/** Exact questions and their sections define a set. Answer outcomes, collection
 * scope and display labels do not. This canonical key is internal, not a DOM ID. */
export const progressQuestionSetKey = (
  point: Pick<ProgressMeasurement, 'slots'>,
): string => {
  return JSON.stringify(progressQuestionKeys(point));
};

/** Reusing a failed execution's captures can still be the first publication of
 * that collection. Its original dates and opaque capture identities must exist. */
export const hasRetainedCaptureIdentity = (
  point: ProgressMeasurement,
): boolean => {
  const captured = point.slots.filter((slot) => slot.captured);

  return (
    point.measurementId !== null &&
    point.captureWindow.start !== null &&
    point.captureWindow.end !== null &&
    captured.length > 0 &&
    captured.every((slot) => slot.captureId !== null)
  );
};

/** When a measurement happened: its last capture, else its publication. An
 * undated measurement sorts first. */
export const progressMeasuredTime = (point: ProgressMeasurement): number => {
  const instant = point.captureWindow.end ?? point.publishedAt;
  const time = instant === null ? Number.NaN : Date.parse(instant);

  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
};

/** One physical capture set gives one point, regardless of execution retries or
 * copy revisions. Unknown legacy baselines remain; unproven reuse and replays do not. */
export const selectProgressMeasurements = (
  history: readonly ProgressMeasurement[],
): ProgressMeasurement[] => {
  const seenRuns = new Set<string>();
  const seenMeasurements = new Set<string>();
  const getPublicationTime = (point: ProgressMeasurement) => {
    return point.publishedAt === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(point.publishedAt);
  };

  const measurements = [...history]
    .sort(
      (left, right) =>
        (progressMeasuredTime(left) === progressMeasuredTime(right)
          ? 0
          : progressMeasuredTime(left) - progressMeasuredTime(right)) ||
        (getPublicationTime(left) === getPublicationTime(right)
          ? 0
          : getPublicationTime(left) - getPublicationTime(right)) ||
        left.runId.localeCompare(right.runId),
    )
    .filter((point) => {
      if (
        ['derived', 'invalid'].includes(point.state) ||
        (point.state === 'reused' && !hasRetainedCaptureIdentity(point)) ||
        seenRuns.has(point.runId) ||
        (point.measurementId && seenMeasurements.has(point.measurementId))
      ) {
        return false;
      }

      seenRuns.add(point.runId);

      if (point.measurementId) {
        seenMeasurements.add(point.measurementId);
      }

      return true;
    });

  return measurements;
};
