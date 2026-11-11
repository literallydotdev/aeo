import type { AeoAgentSurface, AeoApiSurface } from '../surfaces';
import { agentSurfaces, chatSurfaces, isCustomSurface } from '../surfaces';
import { surfaceRetrievalExposure } from '../retrieval';

// ============================================================================
// Detection sanity guards. A CLI or SDK output-format change would zero a
// surface's retrieval data for a quarter with nothing noticing; these turn
// "zero of many" into a recorded partial failure. The trigger is ZERO, not
// a low share: Claude Code legitimately answers many buyer prompts from
// priors, and a chat surface may occasionally return an empty log.
// ============================================================================

// Minimum captured answers on a surface before an all-empty column is
// suspicious rather than small-sample noise.
export const webToolGuardMinAnswers = 8;

export type WebToolGuardInput = {
  surface: string;
  usedWebSearch?: boolean | null;
};

export type PartialFailure = {
  step: string;
  error: string;
};

/**
 * Web-tool detection (correctness spec §3.1): for each agent surface with
 * at least webToolGuardMinAnswers captured answers whose retrieval
 * state is known, returns a partial failure when none of them show web tool
 * use. Unknown (null) rows are not evidence either way and are excluded
 * from the count.
 */
export const checkWebToolDetection = (
  rows: readonly WebToolGuardInput[],
): PartialFailure[] => {
  const failures: PartialFailure[] = [];

  for (const surface of agentSurfaces) {
    const known = rows.filter(
      (row) =>
        row.surface === surface &&
        (row.usedWebSearch === true || row.usedWebSearch === false),
    );

    if (known.length < webToolGuardMinAnswers) {
      continue;
    }

    const searched = known.filter((row) => row.usedWebSearch === true).length;

    if (searched > 0) {
      continue;
    }

    failures.push({
      step: `probes:web_tool_detection:${surface satisfies AeoAgentSurface}`,
      error: `0/${known.length} answers show web tool use; verify detection against the installed CLI`,
    });
  }

  return failures;
};

export type RetrievalCaptureGuardInput = {
  surface: string;
  // Calls in the stored retrieval log; null = no log was stored (parse miss).
  retrievalCalls: number | null;
};

/**
 * Retrieval capture (retrieval-log spec §7): for each `full` chat surface
 * with at least webToolGuardMinAnswers answers CAPTURED BY THIS RUN
 * (resumed checkpoint rows never carry a log and are not evidence of a
 * parse miss), returns a partial failure when none carries a non-empty
 * log. Every such probe ran with `toolChoice: 'required'`, so zero logs
 * means the extractor no longer matches the SDK's result shape.
 */
export const checkRetrievalCapture = (
  freshRows: readonly RetrievalCaptureGuardInput[],
): PartialFailure[] => {
  const failures: PartialFailure[] = [];

  const guarded = [
    ...chatSurfaces.filter(
      (surface) => surfaceRetrievalExposure[surface] === 'full',
    ),
    // A custom surface searches through the gateway's tool, which returns
    // its results: no log across its answers is an extractor miss too.
    ...new Set(
      freshRows
        .map((row) => row.surface)
        .filter(isCustomSurface)
        .sort(),
    ),
  ];

  for (const surface of guarded) {
    const captured = freshRows.filter((row) => row.surface === surface);

    if (captured.length < webToolGuardMinAnswers) {
      continue;
    }

    const logged = captured.filter(
      (row) => row.retrievalCalls !== null && row.retrievalCalls > 0,
    ).length;

    if (logged > 0) {
      continue;
    }

    failures.push({
      step: `probes:retrieval_capture:${surface satisfies AeoApiSurface}`,
      error: `0/${captured.length} answers captured by this run carry a retrieval log; verify the extractor against the installed AI SDK`,
    });
  }

  return failures;
};

export type WebToolParseGuardInput = {
  surface: string;
  usedWebSearch: boolean | null;
};

/**
 * Web-tool parse (hardening spec §2.9): for each agent surface with at
 * least webToolGuardMinAnswers answers CAPTURED BY THIS RUN, returns a
 * partial failure when none of them has a known retrieval state — a CLI
 * format change that makes the parser return `null` on every row would
 * otherwise publish a quarter of "retrieval unknown" silently. Resumed
 * store rows are excluded (the migrated baselines are all-null by design).
 */
export const checkWebToolParse = (
  freshRows: readonly WebToolParseGuardInput[],
): PartialFailure[] => {
  const failures: PartialFailure[] = [];

  for (const surface of agentSurfaces) {
    const captured = freshRows.filter((row) => row.surface === surface);

    if (captured.length < webToolGuardMinAnswers) {
      continue;
    }

    const known = captured.filter((row) => row.usedWebSearch !== null).length;

    if (known > 0) {
      continue;
    }

    failures.push({
      step: `probes:web_tool_parse:${surface satisfies AeoAgentSurface}`,
      error: `0/${captured.length} answers captured by this run have a known web-tool state; verify the stream parser against the installed CLI`,
    });
  }

  return failures;
};

export type CoverageGuardInput = {
  surface: string;
  planned: number;
  captured: number;
};

export type CoverageThresholdsInput = {
  blockAtZero: boolean;
  minCapturedRatio: number;
};

/**
 * Coverage gate (hardening spec §4.1): per surface, captured / planned
 * below the threshold is a partial failure that blocks the write unless
 * the run allows partial output. A surface with zero captures never
 * renders as 0%; a surface below the ratio never renders as a low number.
 */
export const checkCoverage = (
  coverage: readonly CoverageGuardInput[],
  thresholds: CoverageThresholdsInput,
): PartialFailure[] => {
  const failures: PartialFailure[] = [];

  for (const entry of coverage) {
    if (entry.planned === 0) {
      continue;
    }

    const ratio = entry.captured / entry.planned;
    const zero = thresholds.blockAtZero && entry.captured === 0;
    const low = ratio < thresholds.minCapturedRatio;

    if (!zero && !low) {
      continue;
    }

    failures.push({
      step: `probes:coverage:${entry.surface}`,
      error: `${entry.captured}/${entry.planned} planned probes captured (${Math.round(ratio * 100)}%, threshold ${Math.round(thresholds.minCapturedRatio * 100)}%); the surface cannot be published as measured`,
    });
  }

  return failures;
};
