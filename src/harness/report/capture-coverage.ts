import type { RunPlan } from '../../runner';
import type { RunRequest } from '../../schema';
import { checkCoverage } from '../../probes/web-tool-guard';
import type { CaptureArtifact } from './artifacts';

/**
 * Coverage shortfalls of a capture against the plan's surfaces and the
 * admitted thresholds, plus every section that failed outright. The capture
 * step treats a non-empty list as a transient, resumable provider condition
 * (codex-workflow/capture.ts): the next attempt reuses the banked captures
 * and probes only the missing units.
 */
export const captureCoverageIssues = (
  capture: Pick<CaptureArtifact, 'sections' | 'failedSections'>,
  surfaces: RunPlan['surfaces'],
  thresholds: RunRequest['coverageThresholds'],
): string[] => {
  const coverage = surfaces.map((surface) => {
    let planned = 0;
    let captured = 0;

    for (const section of Object.values(capture.sections)) {
      const entry = section.coverage.find((c) => c.surface === surface);
      planned += entry?.planned ?? 0;
      captured += entry?.captured ?? 0;
    }

    return { surface, planned, captured };
  });

  const issues = [
    // The step names the surface; the error alone reads as a bare ratio.
    ...checkCoverage(coverage, thresholds).map(
      (failure) => `${failure.step}: ${failure.error}`,
    ),
    ...capture.failedSections.map((failed) => `${failed.key}: ${failed.error}`),
  ];

  return issues;
};
