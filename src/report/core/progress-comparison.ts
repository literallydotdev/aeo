import { isAgentSurface, type AeoSurface } from './surfaces';
import type { ProgressMeasurement, ProgressSlot } from './progress-schema';
import {
  hasRetainedCaptureIdentity,
  progressQuestionKey,
  progressQuestionKeys,
  progressQuestionSetKey,
} from './progress-question-sets';
import { progressSlotKey } from './progress-slot-key';

export type { ProgressMeasurement, ProgressSlot } from './progress-schema';
export { selectProgressMeasurements } from './progress-question-sets';
export { progressSlotKey } from './progress-slot-key';

export type ProgressCounts = {
  planned: number;
  captured: number;
  analyzed: number;
  citationObserved: number;
  mentioned: number;
  cited: number;
  mentionRate: number | null;
  citationRate: number | null;
};

export type ProgressGroupComparison = {
  baseline: ProgressCounts;
  current: ProgressCounts;
  mentionDeltaPp: number | null;
  citationDeltaPp: number | null;
};

/** Why a comparison is partial or unavailable; progressNotes words each one. */
export type ProgressComparisonReason =
  | 'same_measurement'
  | 'measurement_not_independent'
  | 'company_changed'
  | 'locale_changed'
  | 'no_shared_questions'
  | 'duplicate_planned_slots'
  | 'no_matching_scope'
  | 'scope_changed'
  | 'questions_changed'
  | 'matched_captures_reused'
  | 'incomplete_capture_coverage'
  | 'incomplete_analysis_coverage'
  | 'analyzer_changed'
  | 'collection_method_changed'
  | 'collection_metadata_unknown'
  | 'historical_metadata_unknown'
  | 'includes_reused_captures';

export type ProgressComparison = {
  status: 'comparable' | 'partial' | 'unavailable';
  reasons: ProgressComparisonReason[];
  baselineRunId: string;
  currentRunId: string;
  matched: {
    questions: number;
    slots: number;
    surfaces: AeoSurface[];
    baselineExcludedSlots: number;
    currentExcludedSlots: number;
  };
  groups: {
    chat: ProgressGroupComparison | null;
    agents: ProgressGroupComparison | null;
  };
};

export type ProgressSelection = {
  sectionKey?: string;
  surface?: AeoSurface;
  scope?: 'all' | 'chat' | 'agents';
};

const isSlotSelected = (
  slot: ProgressSlot,
  selection: ProgressSelection,
): boolean => {
  if (selection.sectionKey && slot.sectionKey !== selection.sectionKey) {
    return false;
  }

  if (selection.surface && slot.surface !== selection.surface) {
    return false;
  }

  if (selection.scope === 'chat' && isAgentSurface(slot.surface)) {
    return false;
  }

  if (selection.scope === 'agents' && !isAgentSurface(slot.surface)) {
    return false;
  }

  return true;
};

const countSlots = (slots: readonly ProgressSlot[]): ProgressCounts => {
  const planned = slots.length;
  const mentioned = slots.filter(
    (slot) => slot.analyzed && slot.mentioned,
  ).length;
  const cited = slots.filter(
    (slot) => slot.citationObserved && slot.cited,
  ).length;
  const analyzed = slots.filter((slot) => slot.analyzed).length;
  const citationObserved = slots.filter((slot) => slot.citationObserved).length;

  return {
    planned,
    captured: slots.filter((slot) => slot.captured).length,
    analyzed,
    citationObserved,
    mentioned,
    cited,
    mentionRate: planned && analyzed ? mentioned / planned : null,
    citationRate: planned && citationObserved ? cited / planned : null,
  };
};

/** Compare only the questions both audits asked and the selected planned
 * slots. Missing captures stay in that fixed denominator; scope changes cannot
 * imply growth. */
export const deriveProgressComparison = (
  pair: { baseline: ProgressMeasurement; current: ProgressMeasurement },
  selection: ProgressSelection = {},
): ProgressComparison => {
  const { baseline, current } = pair;
  const result: ProgressComparison = {
    status: 'unavailable',
    reasons: [],
    baselineRunId: baseline.runId,
    currentRunId: current.runId,
    matched: {
      questions: 0,
      slots: 0,
      surfaces: [],
      baselineExcludedSlots: 0,
      currentExcludedSlots: 0,
    },
    groups: { chat: null, agents: null },
  };

  if (
    baseline.runId === current.runId ||
    (baseline.measurementId && baseline.measurementId === current.measurementId)
  ) {
    result.reasons.push('same_measurement');
  }

  if (
    [baseline, current].some(
      (point) =>
        ['derived', 'invalid'].includes(point.state) ||
        (point.state === 'reused' && !hasRetainedCaptureIdentity(point)),
    )
  ) {
    result.reasons.push('measurement_not_independent');
  }

  if (baseline.brandIdentity !== current.brandIdentity) {
    result.reasons.push('company_changed');
  }

  if (
    baseline.geography !== current.geography ||
    baseline.language !== current.language
  ) {
    result.reasons.push('locale_changed');
  }

  const currentQuestions = new Set(progressQuestionKeys(current));
  const sharedQuestions = new Set(
    progressQuestionKeys(baseline).filter((key) => currentQuestions.has(key)),
  );

  if (!sharedQuestions.size) {
    result.reasons.push('no_shared_questions');
  }

  if (result.reasons.length) {
    return result;
  }

  // Edited, added or removed questions leave the comparison; the questions
  // both audits asked stay a like-for-like sample.
  const isShared = (slot: ProgressSlot) => {
    return sharedQuestions.has(progressQuestionKey(slot));
  };
  const left = baseline.slots.filter(
    (slot) => isShared(slot) && isSlotSelected(slot, selection),
  );
  const right = current.slots.filter(
    (slot) => isShared(slot) && isSlotSelected(slot, selection),
  );
  const rightByKey = new Map(
    right.map((slot) => [progressSlotKey(slot), slot]),
  );

  if (
    new Set(left.map(progressSlotKey)).size !== left.length ||
    rightByKey.size !== right.length
  ) {
    result.reasons.push('duplicate_planned_slots');

    return result;
  }

  const matched = left.flatMap((slot) => {
    const other = rightByKey.get(progressSlotKey(slot));

    return other ? [{ baseline: slot, current: other }] : [];
  });
  result.matched = {
    questions: new Set(
      matched.map(({ baseline: slot }) => progressQuestionKey(slot)),
    ).size,
    slots: matched.length,
    surfaces: [
      ...new Set(matched.map(({ baseline: slot }) => slot.surface)),
    ].sort(),
    baselineExcludedSlots: left.length - matched.length,
    currentExcludedSlots: right.length - matched.length,
  };

  if (!matched.length) {
    result.reasons.push('no_matching_scope');

    return result;
  }

  if (
    result.matched.baselineExcludedSlots ||
    result.matched.currentExcludedSlots
  ) {
    result.reasons.push('scope_changed');

    return result;
  }

  if (progressQuestionSetKey(baseline) !== progressQuestionSetKey(current)) {
    result.reasons.push('questions_changed');
  }

  const currentCaptures = matched.filter((entry) => entry.current.captured);

  if (
    currentCaptures.length &&
    currentCaptures.every(
      ({ baseline: a, current: b }) =>
        b.captureId !== null && b.captureId === a.captureId,
    )
  ) {
    result.reasons.push('matched_captures_reused');

    return result;
  }

  if (
    matched.some(({ baseline: a, current: b }) => !a.captured || !b.captured)
  ) {
    result.reasons.push('incomplete_capture_coverage');
  }

  if (
    matched.some(
      ({ baseline: a, current: b }) =>
        !a.analyzed ||
        !b.analyzed ||
        !a.citationObserved ||
        !b.citationObserved,
    )
  ) {
    result.reasons.push('incomplete_analysis_coverage');
  }

  if (
    (baseline.analyzer.version !== null &&
      current.analyzer.version !== null &&
      baseline.analyzer.version !== current.analyzer.version) ||
    (baseline.analyzer.model !== null &&
      current.analyzer.model !== null &&
      baseline.analyzer.model !== current.analyzer.model)
  ) {
    result.reasons.push('analyzer_changed');
  }

  if (
    matched.some(
      ({ baseline: a, current: b }) =>
        a.collectionMetadataKnown &&
        b.collectionMetadataKnown &&
        a.collectionMethodDigest !== b.collectionMethodDigest,
    )
  ) {
    result.reasons.push('collection_method_changed');
  }

  if (
    matched.some(
      ({ baseline: a, current: b }) =>
        (a.captured && !a.collectionMetadataKnown) ||
        (b.captured && !b.collectionMetadataKnown),
    )
  ) {
    result.reasons.push('collection_metadata_unknown');
  }

  if (
    [baseline, current].some(
      (point) =>
        point.state === 'legacy' ||
        point.analyzer.version === null ||
        point.analyzer.model === null,
    )
  ) {
    result.reasons.push('historical_metadata_unknown');
  }

  if (
    [baseline, current].some((point) =>
      ['mixed', 'reused'].includes(point.state),
    )
  ) {
    result.reasons.push('includes_reused_captures');
  }

  for (const scope of ['chat', 'agents'] as const) {
    const group = matched.filter(
      ({ baseline: slot }) =>
        isAgentSurface(slot.surface) === (scope === 'agents'),
    );

    if (!group.length) {
      continue;
    }

    const baselineCounts = countSlots(group.map((entry) => entry.baseline));
    const currentCounts = countSlots(group.map((entry) => entry.current));

    result.groups[scope] = {
      baseline: baselineCounts,
      current: currentCounts,
      mentionDeltaPp:
        currentCounts.mentionRate !== null &&
        baselineCounts.mentionRate !== null
          ? (currentCounts.mentionRate - baselineCounts.mentionRate) * 100
          : null,
      citationDeltaPp:
        currentCounts.citationRate !== null &&
        baselineCounts.citationRate !== null
          ? (currentCounts.citationRate - baselineCounts.citationRate) * 100
          : null,
    };
  }

  result.status = result.reasons.length ? 'partial' : 'comparable';

  return result;
};
