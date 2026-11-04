import { assert, describe, expect, it } from 'vitest';
import {
  progressQuestionSetKey,
  selectProgressMeasurements,
} from '../report/core/progress-question-sets';
import {
  deriveProgressComparison,
  type ProgressMeasurement,
  type ProgressSlot,
} from '../lib/progress-comparison';
import { contentHash } from '../stores/content-hash';

type PointOptions = {
  questions?: string[];
  day?: number;
};

const point = (
  runId: string,
  { questions = ['a', 'b'], day = 1 }: PointOptions = {},
): ProgressMeasurement => {
  const capturedAt = `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const slots: ProgressSlot[] = questions.map((question) => ({
    sectionKey: 'engineering',
    questionKey: contentHash(question),
    surface: 'google_ai_overview',
    runIndex: 1,
    captured: true,
    analyzed: true,
    citationObserved: true,
    captureId: contentHash({ runId, question }),
    mentioned: true,
    cited: true,
    requestedModel: 'model-1',
    cliVersion: null,
    collectionMetadataKnown: true,
    collectionMethodDigest: contentHash('method-1'),
  }));

  const measurement: ProgressMeasurement = {
    version: 1,
    runId,
    publishedAt: capturedAt,
    captureWindow: { start: capturedAt, end: capturedAt },
    measurementId: contentHash({ runId, questions }),
    state: 'independent',
    warnings: [],
    reusedCaptures: 0,
    brandIdentity: contentHash('company-1'),
    geography: 'us',
    language: 'en',
    analyzer: { version: 2, model: 'analyzer-1' },
    slots,
  };

  return measurement;
};

const getAt = <T>(items: readonly T[], index: number): T => {
  const item = items[index];

  assert(item, `Expected an item at index ${index}.`);

  return item;
};

describe('progress-question-sets - comparisons across question changes', () => {
  it.each([
    ['edited', ['a', 'c'], 1],
    ['added', ['a', 'b', 'c'], 2],
    ['removed', ['a'], 1],
  ] as const)(
    'should compare only the shared questions after a question is %s',
    (_change, questions, shared) => {
      const baseline = point('original');
      const current = point('changed', { questions: [...questions], day: 2 });

      const comparison = deriveProgressComparison({ baseline, current });

      expect(comparison.status).toBe('partial');
      expect(comparison.reasons).toEqual(['questions_changed']);
      expect(comparison.matched).toMatchObject({
        questions: shared,
        slots: shared,
        baselineExcludedSlots: 0,
        currentExcludedSlots: 0,
      });
      expect(comparison.groups.chat).toMatchObject({
        baseline: { planned: shared, mentioned: shared },
        current: { planned: shared, mentioned: shared },
        mentionDeltaPp: 0,
      });
    },
  );

  it('should compare a shared section after another market was added', () => {
    const baseline = point('original');
    const current = point('changed', { questions: ['a', 'b', 'c'], day: 2 });
    getAt(current.slots, 2).sectionKey = 'new-market';

    const result = deriveProgressComparison(
      { baseline, current },
      { sectionKey: 'engineering', surface: 'google_ai_overview' },
    );

    expect(result.status).toBe('partial');
    expect(result.reasons).toEqual(['questions_changed']);
    expect(result.matched.questions).toBe(2);
  });

  it('should NOT compare audits that share no questions', () => {
    const baseline = point('original');
    const current = point('replaced', { questions: ['c', 'd'], day: 2 });

    expect(deriveProgressComparison({ baseline, current })).toMatchObject({
      status: 'unavailable',
      reasons: ['no_shared_questions'],
      groups: { chat: null, agents: null },
    });
  });

  it('should keep the same set across question order, outcomes, display names and collection settings', () => {
    const baseline = point('first');
    const current = point('second', { questions: ['b', 'a'], day: 2 });
    baseline.questionSetName = 'Original display name';
    current.questionSetName = 'Renamed display name';
    getAt(current.slots, 0).mentioned = false;
    getAt(current.slots, 1).cited = false;
    current.analyzer.model = 'analyzer-2';

    const comparison = deriveProgressComparison({ baseline, current });

    expect(progressQuestionSetKey(current)).toBe(
      progressQuestionSetKey(baseline),
    );
    expect(comparison.reasons).not.toContain('questions_changed');
    expect(comparison.matched.questions).toBe(2);
  });

  it('should treat moving a question to a different section as a changed question', () => {
    const baseline = point('first');
    const moved = point('moved', { questions: ['a', 'b'], day: 2 });
    getAt(moved.slots, 0).sectionKey = 'different-market';

    const comparison = deriveProgressComparison({ baseline, current: moved });

    expect(comparison.reasons).toEqual(['questions_changed']);
    expect(comparison.matched.questions).toBe(1);
  });

  it.each(['brandIdentity', 'geography', 'language'] as const)(
    'should keep %s boundaries even when exact questions match',
    (field) => {
      const baseline = point('first');
      const current = point('second', { questions: ['a', 'b'], day: 2 });
      current[field] =
        field === 'brandIdentity' ? contentHash('company-2') : 'other';

      const comparison = deriveProgressComparison({ baseline, current });

      expect(progressQuestionSetKey(current)).toBe(
        progressQuestionSetKey(baseline),
      );
      expect(comparison.status).toBe('unavailable');
    },
  );

  it('should list every audit once in measured order, across question changes, without copies or replays', () => {
    const original = point('a-original');
    original.state = 'legacy';
    original.measurementId = null;
    original.captureWindow = { start: null, end: null };
    const changed = point('b-first', { questions: ['a', 'c'], day: 2 });
    const returned = point('a-returned', { questions: ['b', 'a'], day: 3 });
    const copyOnly = { ...returned, publishedAt: '2026-10-01T00:00:00.000Z' };
    const replay = { ...returned, runId: 'replay', state: 'derived' as const };

    const points = selectProgressMeasurements([
      copyOnly,
      changed,
      replay,
      original,
      returned,
    ]);

    expect(points.map((p) => p.runId)).toEqual([
      'a-original',
      'b-first',
      'a-returned',
    ]);
    expect(original.captureWindow).toEqual({ start: null, end: null });
  });

  it('should retain a historical baseline and fixed planned denominator when current answers are missing', () => {
    const historical = point('historical');
    const baseline: ProgressMeasurement = {
      ...historical,
      state: 'legacy',
      measurementId: null,
      captureWindow: { start: null, end: null },
      analyzer: { ...historical.analyzer, model: null },
      slots: historical.slots.map((slot) => ({
        ...slot,
        captureId: null,
        collectionMetadataKnown: false,
        collectionMethodDigest: null,
        requestedModel: null,
      })),
    };
    const current = point('fresh', { questions: ['a', 'b'], day: 2 });
    Object.assign(getAt(current.slots, 1), {
      captured: false,
      analyzed: false,
      citationObserved: false,
      captureId: null,
      mentioned: false,
      cited: false,
    });

    const result = deriveProgressComparison({ baseline, current });

    expect(result.status).toBe('partial');
    expect(result.reasons).toContain('historical_metadata_unknown');
    expect(result.reasons).toContain('incomplete_capture_coverage');
    expect(result.groups.chat).toMatchObject({
      baseline: { planned: 2, mentionRate: 1, citationRate: 1 },
      current: { planned: 2, captured: 1, mentionRate: 0.5, citationRate: 0.5 },
      mentionDeltaPp: -50,
      citationDeltaPp: -50,
    });
  });
});
