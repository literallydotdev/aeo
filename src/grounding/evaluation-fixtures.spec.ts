import { describe, expect, it } from 'vitest';
import { requireDefined } from '../__fixtures__/require-defined';
import {
  groundingEvaluationFixtures,
  materializeEvaluationFixture,
  type GroundingEvaluationFixture,
} from './evaluation-fixtures';

const materializeSingle = (fixture: GroundingEvaluationFixture) => {
  const { bundle, answers } = materializeEvaluationFixture(fixture);

  const materialized = {
    bundle,
    answer: requireDefined(answers[0], `answer of ${fixture.id}`),
    candidate: requireDefined(bundle.candidates[0], `claim of ${fixture.id}`),
  };

  return materialized;
};

const materializeById = (id: string) => {
  const fixture = groundingEvaluationFixtures.find((item) => item.id === id);

  return materializeSingle(requireDefined(fixture, id));
};

describe('evaluation-fixtures - materializeEvaluationFixture()', () => {
  it('should keep diagnostic case names out of every model-visible provenance field', () => {
    const identities = new Set<string>();

    for (const fixture of groundingEvaluationFixtures) {
      const materialized = materializeEvaluationFixture(fixture);
      const serialized = JSON.stringify(materialized);

      for (const diagnostic of groundingEvaluationFixtures) {
        expect(serialized).not.toContain(diagnostic.id);
      }

      const { bundle, answer } = materializeSingle(fixture);
      const runId = requireDefined(bundle.runId, `run of ${fixture.id}`);

      expect(runId).toMatch(/^run-[a-f0-9]{24}$/);
      expect(answer.id).toMatch(/^answer-[a-f0-9]{24}$/);
      expect(identities.has(runId)).toBe(false);

      identities.add(runId);

      expect(materializeEvaluationFixture(fixture)).toEqual(materialized);
    }
  });

  it('should give ordinary capability claims contemporaneous evidence without inventing publication dates', () => {
    for (const fixture of groundingEvaluationFixtures) {
      if (fixture.capturedAt !== undefined) {
        continue;
      }

      const { bundle, answer, candidate } = materializeSingle(fixture);

      expect(answer.capturedAt).toBe(bundle.reviewAsOf);
      expect(candidate.scope.applicableAt).toBe(bundle.reviewAsOf);

      for (const source of bundle.sources) {
        expect(source.fetchedAt).toBe(bundle.reviewAsOf);
        expect(source.sourceDate).toBeNull();
      }
    }
  });

  it('should preserve unknown and historical answer times for temporal edge cases', () => {
    const unknown = materializeById('unknown-capture-time');

    expect(unknown.answer.capturedAt).toBeNull();
    expect(unknown.candidate.scope.applicableAt).toBeNull();

    for (const id of [
      'future-announcement',
      'new-docs-old-answer',
      'retrospective-correction',
    ]) {
      const { bundle, answer, candidate } = materializeById(id);
      const capturedAt = requireDefined(
        answer.capturedAt ?? undefined,
        `capture time of ${id}`,
      );

      expect(capturedAt).toBe('2026-05-01T00:00:00.000Z');
      expect(candidate.scope.applicableAt).toBe(capturedAt);
      expect(Date.parse(bundle.reviewAsOf)).toBeGreaterThan(
        Date.parse(capturedAt),
      );
    }
  });
});
