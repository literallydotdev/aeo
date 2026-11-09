import { ProbeAdapterId } from '../probes/adapter';
import type { TokenUsage } from './pricing';

// ============================================================================
// The coefficients the cost estimate and the ledger's reservations are
// computed from (specs/aeo-claude-operator-spec.md §4.2): tokens per
// captured answer and per run for the Codex stages and the host's calls,
// and dollars per probe and per search. A versioned resource, recalibrated
// each release from recorded runs' journals, which hold every session's
// usage. The estimate is a range, never a quote.
//
// Calibration 1 (2026-11-04): four local runs of 16 and 32 answers and one
// author session (src/models/__fixtures__/calibration-runs.json). The
// per-answer stages (analyze, qualify, review) used 34,000 to 62,000 input
// and 4,500 to 11,000 output tokens per answer; the write stage 280,000 to
// 760,000 input and 11,000 to 27,000 output tokens per run; 71 to 94
// percent of stage input was served from cache. The host calls used 2,000
// to 4,500 input and 4,400 to 8,000 output tokens per answer under
// extraction-only grounding, and 7,700 to 13,500 input and 11,000 to 13,000
// output under full grounding: reasoning is billed as output. The high
// ends carry headroom for a stronger model's longer reasoning and for
// review rounds.
//
// The spike (2026-11-04) ran one analyze batch of ten answers on each
// supported model: about 7,000 input and 300 to 450 output tokens per
// answer, none of the input served from cache. The cached share therefore
// runs from none at the dear end to the measured share at the cheap end.
//
// The probe and search figures are not calibrated yet: they are rough
// per-request assumptions (a probe's model tokens and its provider's search
// fee), to be replaced by the costs the gateway reports.
//
// Version 2 (probe adapters spec §4.8) keys the probe figures by adapter
// rather than by surface, with version 1's numbers for every default
// adapter: a surface costs what the adapter it is bound to costs.
// ============================================================================

export const costCoefficientsVersion = 2;

export type TokenRange = {
  input: number;
  output: number;
};

export type Range<T> = { low: T; high: T };

/** Codex stage tokens. `perAnswer` covers every stage that reads answer
 * files; `perRun` the write stage, which reads the whole report. */
export const stageTokens = {
  perAnswer: {
    low: { input: 30_000, output: 4000 },
    high: { input: 90_000, output: 16_000 },
  },
  perRun: {
    low: { input: 250_000, output: 10_000 },
    high: { input: 900_000, output: 40_000 },
  },
  /** The share of stage input served from cache: high is cheap. The
   * supported models reported none through the gateway in the spike. */
  cachedShare: { low: 0, high: 0.8 },
} as const;

/** The one author session. */
export const authorTokens = {
  session: {
    low: { input: 250_000, output: 10_000 },
    high: { input: 800_000, output: 45_000 },
  },
} as const;

/** The author's research searches at the low end; the high end is the
 * research tools' own spend cap (`authorToolCaps.searchSpendUsd`). */
export const authorSearchLowUsd = 0.05;

/** The host's own model calls per captured answer, by grounding:
 * perception, source labels and the copy verifier always; claim research
 * and adjudication under full grounding. */
export const hostTokensPerAnswer = {
  extraction_only: {
    low: { input: 1500, output: 3000 },
    high: { input: 8000, output: 12_000 },
  },
  full: {
    low: { input: 6000, output: 6000 },
    high: { input: 24_000, output: 18_000 },
  },
} as const;

/** Grounding search per captured answer under full grounding. */
export const searchUsdPerAnswer = { low: 0.001, high: 0.01 } as const;

/** One probe unit, by adapter, in USD. The coding-agent CLIs run on the
 * operator's own plan and bill nothing to the run's cap. */
export const probeUsd: Readonly<Record<ProbeAdapterId, Range<number>>> = {
  [ProbeAdapterId.GATEWAY_OPENAI]: { low: 0.01, high: 0.05 },
  [ProbeAdapterId.GATEWAY_GOOGLE]: { low: 0.02, high: 0.06 },
  [ProbeAdapterId.GATEWAY_ANTHROPIC]: { low: 0.02, high: 0.08 },
  [ProbeAdapterId.GATEWAY_PERPLEXITY]: { low: 0.01, high: 0.03 },
  [ProbeAdapterId.DATAFORSEO_AI_OVERVIEW]: { low: 0.002, high: 0.006 },
  [ProbeAdapterId.CLI_CLAUDE_CODE]: { low: 0, high: 0 },
  [ProbeAdapterId.CLI_CODEX]: { low: 0, high: 0 },
  [ProbeAdapterId.CLI_CURSOR]: { low: 0, high: 0 },
};

/** The calibrated workload a Codex session is: a batch of answer files
 * (analyze, qualify, review), the whole report (write) or a brief
 * (author). Each stage's descriptor names its own. */
export type SessionCost = 'answers' | 'report' | 'brief';

/**
 * sessionReservation is what one Codex session is reserved at before it
 * starts: the same high figures, cache share included, that the estimate's
 * high end assumes, so a run under the cap the estimate recommends is never
 * refused for its reservations. The session settles at the tokens it
 * reports; its reservation bounds how far one session can carry the run
 * past its cap.
 */
export const sessionReservation = ({
  cost,
  answers,
}: {
  cost: SessionCost;
  answers: number;
}): TokenUsage => {
  // One session is one stage over its batch; the per-answer high covers
  // all three such stages, the heaviest two of which take about half each.
  const batch = {
    input: 50_000 + answers * (stageTokens.perAnswer.high.input / 2),
    output: 8000 + answers * (stageTokens.perAnswer.high.output / 2),
  };
  const tokens = {
    answers: batch,
    report: stageTokens.perRun.high,
    brief: authorTokens.session.high,
  }[cost];

  const reservation: TokenUsage = {
    inputTokens: tokens.input,
    cachedInputTokens: Math.round(tokens.input * stageTokens.cachedShare.low),
    outputTokens: tokens.output,
  };

  return reservation;
};
