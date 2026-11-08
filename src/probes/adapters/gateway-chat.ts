import { streamText, type ToolSet } from 'ai';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { anthropic } from '@ai-sdk/anthropic';
import { createLog } from '../../lib/log';
import { gatewayCostUsd } from '../../models/gateway-cost';
import { probeUsd } from '../../models/cost-coefficients';
import type { RetrievalLog } from '../../schema';
import type { AeoChatSurface } from '../../surfaces';
import {
  ProbeAdapterId,
  type ChatModelProvider,
  type ProbeAdapter,
  type ProbeAdapterProfile,
  type ProbeAnswer,
  type ProbeFailureClass,
} from '../adapter';
import {
  extractAnthropicRetrieval,
  extractGeminiRetrieval,
  extractOpenAiRetrieval,
  type RetrievalStep,
} from '../chat-retrieval';
import { classifyGatewayError, errorMessage, ProbeFailure } from '../failure';

// ============================================================================
// Chat surfaces through the Vercel AI Gateway with the provider's own web
// search tool (gateway.openai, gateway.google, gateway.anthropic): one
// search-required call and, when it returns no prose, one synthesis
// follow-up over its results. The request is the method: the prompt
// prefix, the tool, the token cap and the tool choice.
// ============================================================================

const log = createLog('AISearchProbes');

export const probeMaxOutputTokens = 2000;
// A search-required call plus a synthesis follow-up: bounded by the runner
// (hardening spec §4.5), never by undici's defaults plus SDK retries.
export const chatProbeTimeoutMs = 180_000;

export const searchPromptPrefix =
  'Search the web for current information to answer the following question. Return a complete answer, not just search results.\n\n';

/** reportedCostOf sums the reported costs of a probe's calls; absent unless
 * every call reported one. */
export const reportedCostOf = (
  costs: readonly (number | undefined)[],
): { reportedCostUsd?: number } => {
  if (costs.some((cost) => cost === undefined)) {
    return {};
  }

  return {
    reportedCostUsd: costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
  };
};

/** classifyGatewayFailure keeps the error's kind and its message. */
export const classifyGatewayFailure = (error: unknown): ProbeFailureClass => {
  return { kind: classifyGatewayError(error), message: errorMessage(error) };
};

/**
 * toProviderToolSet hands provider-defined tools to `streamText`.
 */
const toProviderToolSet = (tools: Record<string, unknown>): ToolSet => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- The provider packages declare their tools against a different Tool type than the `ai` package.
  return tools as ToolSet;
};

// The slice of a model result the retrieval extractors read.
type SearchProbeResult = {
  steps: ReadonlyArray<RetrievalStep>;
  providerMetadata: unknown;
};

type GatewayChatMethod = {
  profile: ProbeAdapterProfile;
  /** Built per call, as the request carries it. */
  tools: () => Record<string, unknown>;
  extractRetrieval: (result: SearchProbeResult) => RetrievalLog;
};

const searchProbe = async ({
  surface,
  gateway,
  model,
  promptText,
  method,
}: {
  surface: AeoChatSurface;
  gateway: ChatModelProvider;
  model: string;
  promptText: string;
  method: GatewayChatMethod;
}): Promise<ProbeAnswer> => {
  const prompt = `${searchPromptPrefix}${promptText}`;
  // Streamed like every other non-trivial response: the gateway abandons a
  // non-streaming request at 340 seconds whatever the caller's own timeout.
  // Without an `onError` the SDK prints a provider failure with
  // `console.error`, which includes the full prompt, and then hands the
  // caller a causeless error the retry classifier cannot read.
  let streamFailure: unknown;
  const streamed = streamText({
    onError: ({ error }) => {
      streamFailure ??= error;
    },
    model: gateway(model),
    prompt,
    maxOutputTokens: probeMaxOutputTokens,
    tools: toProviderToolSet(method.tools()),
    toolChoice: 'required',
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(chatProbeTimeoutMs),
  });

  // Drain the stream once; every field below resolves from that one pass,
  // and every one of them is read behind the same unwrapping, so a provider
  // failure is never seen as the SDK's stand-in error.
  const [
    steps,
    text,
    sources,
    finishReason,
    toolCalls,
    response,
    providerMetadata,
  ] = await Promise.all([
    streamed.steps,
    streamed.text,
    streamed.sources,
    streamed.finishReason,
    streamed.toolCalls,
    streamed.response,
    streamed.providerMetadata,
  ]).catch((error: unknown) => {
    throw streamFailure ?? error;
  });

  // The retrieval log comes from this first, search-required call only; the
  // synthesis follow-up below runs with toolChoice: 'none' and contributes
  // nothing. An empty log after a required tool call is an extractor miss
  // (§7), not a from-memory answer: log it and store no retrieval, so the
  // row renders "not captured" rather than "no searches".
  let retrieval: RetrievalLog | null = method.extractRetrieval({
    steps,
    providerMetadata,
  });

  if (retrieval.calls.length === 0) {
    log.warn('Search-required probe yielded no retrieval calls; not stored', {
      model: surface,
      stepCount: steps.length,
      partTypes: [
        ...new Set(steps.flatMap((step) => step.content.map((p) => p.type))),
      ],
    });

    retrieval = null;
  }

  const firstCost = gatewayCostUsd(providerMetadata);

  if (text.trim().length > 0) {
    return {
      answerText: text,
      sources: { format: 'search', sources },
      retrieval,
      servedModel: response.modelId,
      ...reportedCostOf([firstCost]),
    };
  }

  log.warn('Search probe returned no answer text; synthesizing from search', {
    model: surface,
    finishReason,
    toolCallCount: toolCalls.length,
    sourceCount: sources.length,
  });

  // The follow-up is its own stream with its own failure: a 429 here is
  // capacity, to be retried as such, and must not be read through the
  // first stream's error or mistaken for a parser slip.
  let followupFailure: unknown;
  const followupStream = streamText({
    onError: ({ error }) => {
      followupFailure ??= error;
    },
    model: gateway(model),
    messages: [
      { role: 'user', content: prompt },
      ...response.messages,
      {
        role: 'user',
        content:
          'Using the web search results from the previous turn, answer the original question in a complete, readable response. Do not perform another search. If the search results were insufficient, say what was missing.',
      },
    ],
    maxOutputTokens: probeMaxOutputTokens,
    tools: toProviderToolSet(method.tools()),
    toolChoice: 'none',
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(chatProbeTimeoutMs),
  });

  const [followupText, followupSources, followupMetadata] = await Promise.all([
    followupStream.text,
    followupStream.sources,
    followupStream.providerMetadata,
  ]).catch((error: unknown) => {
    throw followupFailure ?? error;
  });

  if (followupText.trim().length > 0) {
    return {
      answerText: followupText,
      sources: {
        format: 'search',
        sources: sources.length > 0 ? sources : followupSources,
      },
      retrieval,
      servedModel: response.modelId,
      ...reportedCostOf([firstCost, gatewayCostUsd(followupMetadata)]),
    };
  }

  // No answer after the search and the synthesis follow-up: a failed unit
  // (hardening spec §2.4), retried like a transient failure — never banked
  // as a measured absence.
  throw new ProbeFailure(
    'empty_answer',
    `${surface} completed a required web search but returned no answer text (tool calls: ${toolCalls.length}, sources: ${sources.length})`,
  );
};

const gatewayChatProfile = (
  id: ProbeAdapterProfile['id'],
  surface: 'chatgpt' | 'gemini' | 'claude',
  retrieval: ProbeAdapterProfile['observes']['retrieval'],
): ProbeAdapterProfile => {
  return {
    id,
    observes: { retrieval, servedModel: 'compare_to_requested' },
    settings: [{ name: 'AI_GATEWAY_API_KEY', secret: true }],
    pool: 'gateway',
    retry: 'chat',
    estimateUsd: probeUsd[surface],
    billing: 'metered',
    resolvesRedirects: true,
  };
};

export type GatewayChatAdapterId =
  | typeof ProbeAdapterId.GATEWAY_OPENAI
  | typeof ProbeAdapterId.GATEWAY_GOOGLE
  | typeof ProbeAdapterId.GATEWAY_ANTHROPIC;

const gatewayChatMethods: Record<GatewayChatAdapterId, GatewayChatMethod> = {
  [ProbeAdapterId.GATEWAY_OPENAI]: {
    profile: gatewayChatProfile(
      ProbeAdapterId.GATEWAY_OPENAI,
      'chatgpt',
      'full',
    ),
    tools: () => ({ web_search: openai.tools.webSearch({}) }),
    extractRetrieval: (result) => extractOpenAiRetrieval(result.steps),
  },
  [ProbeAdapterId.GATEWAY_GOOGLE]: {
    profile: gatewayChatProfile(
      ProbeAdapterId.GATEWAY_GOOGLE,
      'gemini',
      'partial',
    ),
    tools: () => ({ google_search: google.tools.googleSearch({}) }),
    extractRetrieval: (result) =>
      extractGeminiRetrieval(result.providerMetadata),
  },
  [ProbeAdapterId.GATEWAY_ANTHROPIC]: {
    profile: gatewayChatProfile(
      ProbeAdapterId.GATEWAY_ANTHROPIC,
      'claude',
      'full',
    ),
    tools: () => ({
      web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }),
    }),
    extractRetrieval: (result) => extractAnthropicRetrieval(result.steps),
  },
};

export const gatewayChatProfiles = {
  [ProbeAdapterId.GATEWAY_OPENAI]:
    gatewayChatMethods[ProbeAdapterId.GATEWAY_OPENAI].profile,
  [ProbeAdapterId.GATEWAY_GOOGLE]:
    gatewayChatMethods[ProbeAdapterId.GATEWAY_GOOGLE].profile,
  [ProbeAdapterId.GATEWAY_ANTHROPIC]:
    gatewayChatMethods[ProbeAdapterId.GATEWAY_ANTHROPIC].profile,
} satisfies Record<GatewayChatAdapterId, ProbeAdapterProfile>;

/** createGatewayChatAdapter is one search-required chat adapter, asking
 * `model` on `surface` through the run's `gateway`. */
export const createGatewayChatAdapter = (
  id: GatewayChatAdapterId,
  {
    surface,
    gateway,
    model,
  }: { surface: AeoChatSurface; gateway: ChatModelProvider; model: string },
): ProbeAdapter => {
  const method: GatewayChatMethod = gatewayChatMethods[id];

  const adapter: ProbeAdapter = {
    ...method.profile,
    surface,
    model,
    probe: (promptText) =>
      searchProbe({ surface, gateway, model, promptText, method }),
    classifyError: classifyGatewayFailure,
  };

  return adapter;
};
