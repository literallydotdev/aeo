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
//
// Version 3 (open models spec §7) adds what one probe is assumed to use,
// by adapter: tokens and searches. A probe of a model the engine has no
// flat figure for costs those at the model's catalog price. The flat
// figures are unchanged, except Anthropic's: the new default model's first
// recorded answer spent most of the old high end on a single search. It
// also adds the two consumer-app scrapes (method release spec §5).
//
// Calibration 2 (2026-11-11), still version 3: the first recorded run on
// the supported models with full grounding (30 answers, the fifth run of
// calibration-runs.json) and 24 probes of the default bindings on six
// buyer questions. That run's host calls used 5,900 input and 370 output
// tokens per answer, a fifteenth of the output the earlier runs' model
// billed, and its research fetched pages without one paid search, so both
// low ends came down. The probe figures are now the costs the gateway
// reported, with room above the dearest.
//
// The copy's first draft is one request since the same release (method
// release spec §4.5), not the write session calibration 1 measured, so it
// is estimated among the host's calls and no longer among the stages.
// ============================================================================

export const costCoefficientsVersion = 3;

export type TokenRange = {
  input: number;
  output: number;
};

export type Range<T> = { low: T; high: T };

/** Codex stage tokens, for the stages that read answer files: analyze,
 * qualify and review. */
export const stageTokens = {
  perAnswer: {
    low: { input: 30_000, output: 4000 },
    high: { input: 90_000, output: 16_000 },
  },
  /** The share of stage input served from cache: high is cheap. The
   * supported models reported none through the gateway in the spike. */
  cachedShare: { low: 0, high: 0.8 },
} as const;

/** The copywriter's one request per run. Not measured yet: the documents
 * two recorded runs gave their writer came to 8,000 and 16,000 tokens, and
 * the draft itself is some hundreds of words; the high end is a larger
 * audit's documents and a model that reasons at length before it answers. */
export const copyRequestTokens = {
  low: { input: 8000, output: 1000 },
  high: { input: 30_000, output: 12_000 },
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
    low: { input: 5000, output: 300 },
    high: { input: 24_000, output: 18_000 },
  },
} as const;

/** Grounding search per captured answer under full grounding. Research
 * that reads the pages it already holds searches nothing. */
export const searchUsdPerAnswer = { low: 0, high: 0.01 } as const;

/** One probe unit, by adapter, in USD. The coding-agent CLIs run on the
 * operator's own plan and bill nothing to the run's cap. */
export const probeUsd: Readonly<Record<ProbeAdapterId, Range<number>>> = {
  [ProbeAdapterId.GATEWAY_OPENAI]: { low: 0.01, high: 0.05 },
  // openai/gpt-6-luna on buyer questions (2026-11-11): $0.022 to $0.078 an
  // answer, the same under @1 (12 answers) and under @2 (6). The model
  // searches two to seven times and reads 21,000 to 64,000 tokens, where
  // the earlier one searched once or twice. The high end leaves room above
  // the dearest of them.
  [ProbeAdapterId.GATEWAY_OPENAI_2]: { low: 0.02, high: 0.1 },
  // google/gemini-3.5-flash-lite on the same questions: $0.030 to $0.044.
  [ProbeAdapterId.GATEWAY_GOOGLE]: { low: 0.02, high: 0.06 },
  // The adapter allows five searches. A recorded answer with one search
  // cost $0.056 (anthropic/claude-sonnet-5, 2026-11-11: 19,000 tokens in at
  // $0.038, $0.008 out, $0.01 for the search), so the high end is five
  // searches of that size and a full answer, with room.
  [ProbeAdapterId.GATEWAY_ANTHROPIC]: { low: 0.05, high: 0.3 },
  // The same model on buyer questions (2026-11-11): $0.119 to $0.289 an
  // answer under @2 (6 answers), as under @1 ($0.114 to $0.281), with two
  // to four searches and 37,000 to 107,000 tokens in. The high end is what
  // none of them reached: five searches, a quarter more input than the
  // dearest, and the whole 16,000 tokens of output.
  [ProbeAdapterId.GATEWAY_ANTHROPIC_2]: { low: 0.1, high: 0.5 },
  // perplexity/sonar on the same questions: $0.003 to $0.007.
  [ProbeAdapterId.GATEWAY_PERPLEXITY]: { low: 0.003, high: 0.03 },
  // Never read: the engine binds no model of its own to this adapter, so a
  // probe through it is always priced from the catalog (probeEstimateUsd).
  [ProbeAdapterId.GATEWAY_SEARCH]: { low: 0.02, high: 0.1 },
  [ProbeAdapterId.DATAFORSEO_AI_OVERVIEW]: { low: 0.002, high: 0.006 },
  // Every answered request of both consumer-app scrapes reported $0.004
  // (56 requests, 2026-11-11). The high end is a unit whose first attempt
  // was billed without an answer and then retried.
  [ProbeAdapterId.DATAFORSEO_AI_MODE]: { low: 0.004, high: 0.008 },
  [ProbeAdapterId.DATAFORSEO_CHATGPT_APP]: { low: 0.004, high: 0.008 },
  [ProbeAdapterId.CLI_CLAUDE_CODE]: { low: 0, high: 0 },
  [ProbeAdapterId.CLI_CODEX]: { low: 0, high: 0 },
  [ProbeAdapterId.CLI_CURSOR]: { low: 0, high: 0 },
};

/** What one probe of a model-API adapter is assumed to use, for a model
 * the engine has no flat figure for. The range holds the 24 probes of the
 * default bindings on buyer questions (2026-11-11): 6,000 to 109,000
 * tokens in, mostly the search results the provider feeds the model, 200
 * to 2,900 out, and up to seven searches. The output's high end leaves
 * room for a model that reasons more: it bills its thinking as output. */
export const probeUsage = {
  input: { low: 6000, high: 120_000 },
  output: { low: 200, high: 8000 },
  searches: { low: 1, high: 7 },
} as const;

/** What one probe through the gateway's own search tool is assumed to
 * use. The gateway runs that tool loop itself and nothing caps how often a
 * model searches, so one probe reads more than a provider's own search
 * feeds it: the first recorded one (mistral/mistral-large-4, 2026-11-11)
 * searched five times and read 37,000 tokens. The high end is about twice
 * that probe, until more are recorded. */
export const gatewaySearchProbeUsage = {
  input: { low: 8000, high: 75_000 },
  output: { low: 500, high: 8000 },
  searches: { low: 1, high: 10 },
} as const;

/** The search fee per request assumed for a model whose catalog entry
 * lists none. */
export const probeSearchUsd = 0.01;

/** What the gateway charges for one request of its own search tool: "$5
 * per 1,000 requests" (vercel.com/docs/ai-gateway/web-search, read
 * 2026-11-10). The gateway's reported cost of a recorded probe agrees:
 * $0.025 above its inference cost for five searches (2026-11-11). */
export const gatewaySearchUsd = 0.005;

/** The calibrated workload a Codex session is: a batch of answer files
 * (analyze, qualify, review) or a brief (author). Each stage that runs a
 * session names its own; the copywriter runs none. */
export type SessionCost = 'answers' | 'brief';

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
    brief: authorTokens.session.high,
  }[cost];

  const reservation: TokenUsage = {
    inputTokens: tokens.input,
    cachedInputTokens: Math.round(tokens.input * stageTokens.cachedShare.low),
    outputTokens: tokens.output,
  };

  return reservation;
};
