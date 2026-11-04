import { describe, expect, it } from 'vitest';
import type { RunPlan } from '../../runner';
import { runRequestSchema } from '../../schema';
import type { CaptureArtifact } from './artifacts';
import { captureCoverageIssues } from './capture-coverage';

const thresholds = runRequestSchema.parse({
  reportKey: 'deno',
  runId: '01HARNESS000000000000000',
  configVersion: 1,
}).coverageThresholds;
const surfaces = ['chatgpt', 'google_ai_overview'] as RunPlan['surfaces'];

const section = (
  coverage: { surface: string; planned: number; captured: number }[],
): CaptureArtifact['sections'][string] => {
  return { coverage } as unknown as CaptureArtifact['sections'][string];
};

describe('capture-coverage - captureCoverageIssues()', () => {
  it('should accept a capture that met every planned surface', () => {
    expect(
      captureCoverageIssues(
        {
          sections: {
            s1: section([
              { surface: 'chatgpt', planned: 3, captured: 3 },
              { surface: 'google_ai_overview', planned: 1, captured: 1 },
            ]),
          },
          failedSections: [],
        },
        surfaces,
        thresholds,
      ),
    ).toEqual([]);
  });

  it('should name a surface that lost its only planned probe and every failed section', () => {
    const issues = captureCoverageIssues(
      {
        sections: {
          s1: section([
            { surface: 'chatgpt', planned: 3, captured: 3 },
            { surface: 'google_ai_overview', planned: 1, captured: 0 },
          ]),
        },
        failedSections: [
          { key: 's2', error: 'Section probes returned no results' },
        ],
      },
      surfaces,
      thresholds,
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('google_ai_overview');
    expect(issues[1]).toBe('s2: Section probes returned no results');
  });

  it('should sum coverage across sections and ignores surfaces the plan never scheduled', () => {
    expect(
      captureCoverageIssues(
        {
          sections: {
            s1: section([{ surface: 'chatgpt', planned: 2, captured: 1 }]),
            s2: section([{ surface: 'chatgpt', planned: 2, captured: 2 }]),
          },
          failedSections: [],
        },
        surfaces,
        thresholds,
      ),
    ).toEqual([]);
  });
});
