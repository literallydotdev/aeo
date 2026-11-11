import type { LanguageModel } from 'ai';
import type { Range } from '../models/cost-coefficients';
import type { RetrievalExposure, RetrievalLog } from '../schema';
import type { AeoSurface } from '../surfaces';
import type { AIOverviewReference } from './dataforseo';
import type { ProbeFailureKind } from './failure';
import type { ProbeProvider } from './limits';

// ============================================================================
// The probe port (specs/aeo-probe-adapters-spec.md §4.2): one vendor's way
// of asking one buyer question on one surface. An adapter translates the
// vendor's request and response and classifies its errors; the host's
// attempt loop (attempt.ts) owns the pools, the journal, retries, answer
// finalisation and banking. Importing this module loads no SDK.
// ============================================================================

/** Every registered adapter, with its version. A change to an adapter's
 * request or parsing bumps its version. */
export const ProbeAdapterId = {
  GATEWAY_OPENAI: 'gateway.openai@1',
  // The same request with room to finish (method release spec §4.4): a
  // model that reasons and searches can spend @1's 2,000 output tokens
  // before it writes an answer, which then carries no source.
  GATEWAY_OPENAI_2: 'gateway.openai@2',
  GATEWAY_GOOGLE: 'gateway.google@1',
  GATEWAY_ANTHROPIC: 'gateway.anthropic@1',
  GATEWAY_PERPLEXITY: 'gateway.perplexity@1',
  // Any gateway model, searching through the gateway's own search tool.
  GATEWAY_SEARCH: 'gateway.search@1',
  DATAFORSEO_AI_OVERVIEW: 'dataforseo.ai_overview@1',
  // The consumer apps, scraped by DataForSEO (method release spec §5).
  DATAFORSEO_AI_MODE: 'dataforseo.ai_mode@1',
  DATAFORSEO_CHATGPT_APP: 'dataforseo.chatgpt_app@1',
  CLI_CLAUDE_CODE: 'cli.claude_code@1',
  CLI_CODEX: 'cli.codex@1',
  CLI_CURSOR: 'cli.cursor@1',
} as const;

export type ProbeAdapterId =
  (typeof ProbeAdapterId)[keyof typeof ProbeAdapterId];

/** A setting an adapter reads. Settings that share a group are
 * alternatives: any one of them is enough. `billsAccount` names the
 * provider account an auth setting bills per use, outside the run's cap;
 * plan and doctor disclose it. */
export type ProbeSetting = {
  name: string;
  secret: boolean;
  group?: 'auth';
  billsAccount?: string;
};

/** The retry family whose rules the host applies (attempt.ts). */
export type ProbeRetryFamily = 'chat' | 'agent';

/** `metered`: every attempt is reserved against the run's budget;
 * `subscription`: the operator's own plan pays, and nothing is reserved. */
export type ProbeBilling = 'metered' | 'subscription';

/** How the host reads the model an answer names: through servedModelOf
 * against the requested model, as the CLI or the scraper reported it, or
 * not at all. */
export type ServedModelRule = 'compare_to_requested' | 'raw' | 'none';

/** What an adapter is, independent of a run: what it observes, what it
 * needs, which pool and retry rules it runs under, and what it costs. */
export type ProbeAdapterProfile = {
  id: ProbeAdapterId;
  observes: { retrieval: RetrievalExposure; servedModel: ServedModelRule };
  settings: readonly ProbeSetting[];
  pool: Exclude<ProbeProvider, 'analyzer'>;
  retry: ProbeRetryFamily;
  estimateUsd: Range<number>;
  billing: ProbeBilling;
  /** Google's grounding redirects in the answer and its retrieval log are
   * resolved to their targets before the answer is banked. */
  resolvesRedirects: boolean;
};

/** The sources an answer cites, rendered after the body (answer-text.ts). */
export type AnswerSources =
  | { format: 'search'; sources: readonly unknown[] }
  | { format: 'ai_overview'; references: readonly AIOverviewReference[] }
  | { format: 'none' };

export type ProbeAnswer = {
  /** The body, without the source block. */
  answerText: string;
  sources: AnswerSources;
  /** null: the log could not be captured. */
  retrieval: RetrievalLog | null;
  /** Google AI Overview's honest absence. */
  noOverview?: true;
  /** The model asked for, when the request names it only at answer time
   * (Codex); null when the CLI's own default answered. */
  requestedModel?: string | null;
  /** The model the provider or CLI named, raw; observes.servedModel says
   * how the host reads it. */
  servedModel?: string;
  reportedCostUsd?: number;
  /** Coding agents only; null stays unknown. */
  usedWebSearch?: boolean | null;
};

export type ProbeContext = { signal?: AbortSignal };

/** A request as the adapter dispatches it: the prompt it sends, with any
 * prefix, and the parameters that shape the answer. Recorded when an
 * attempt starts (spec §4.9). */
export type ProbeRequest = {
  prompt: string;
  parameters: Readonly<Record<string, unknown>>;
};

/** The models a chat adapter asks through, by model ID: the run's Vercel AI
 * Gateway provider, created with the run's own key. */
export type ChatModelProvider = (modelId: string) => LanguageModel;

export type ProbeFailureClass = { kind: ProbeFailureKind; message: string };

/** One adapter instance, serving one surface. */
export type ProbeAdapter = ProbeAdapterProfile & {
  surface: AeoSurface;
  /** The model the binding pins, for an adapter that calls a model API. */
  model?: string;
  /** The request `probe` dispatches for `promptText`, built from the same
   * values the dispatch uses. */
  request: (promptText: string) => ProbeRequest;
  probe: (promptText: string, ctx: ProbeContext) => Promise<ProbeAnswer>;
  /** The message is journaled, so it never carries the prompt. */
  classifyError: (error: unknown) => ProbeFailureClass;
};
