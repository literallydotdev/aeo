import { streamText, type ToolSet } from 'ai';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { anthropic } from '@ai-sdk/anthropic';
import { gateway as gatewaySdk } from '@ai-sdk/gateway';
import { createLog } from '../../lib/log';
import { isRecord } from '../../lib/type-guards';
import { gatewayCostUsd } from '../../models/gateway-cost';
import { probeUsd } from '../../models/cost-coefficients';
import type { RetrievalLog } from '../../schema';
import type { AeoApiSurface } from '../../surfaces';
import {
  ProbeAdapterId,
  type ChatModelProvider,
  type ProbeAdapter,
  type ProbeAdapterProfile,
  type ProbeAnswer,
  type ProbeFailureClass,
  type ProbeRequest,
} from '../adapter';
import {
  extractAnthropicRetrieval,
  extractGatewaySearchRetrieval,
  extractGeminiRetrieval,
  gatewaySearchToolName,
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

/**
 * The output allowance of gateway.openai@2, gateway.anthropic@2 and
 * gateway.search@1: room for the models of 2026 to finish an answer to a
 * buyer question. Measured on six such questions (2026-11-11, method
 * release spec §4.4), under the released 2,000 tokens:
 *
 * - openai/gpt-6-luna bills its thinking and its tool calls as output, and
 *   ran out while it was still searching. The search call ended on its
 *   token limit with no text, the follow-up, which searches nothing, wrote
 *   the answer, and 6 of 12 answers carried no source at all. The same
 *   questions on the earlier model gave none without a source in 38.
 * - anthropic/claude-sonnet-5 was cut off mid-sentence in 4 of 6 answers.
 *
 * With this allowance both finished all six answers, each whole and with
 * its sources: the first in at most 2,918 output tokens, the second in at
 * most 3,422, at the cost they had before. The other two default models
 * finished inside 2,000 (1,027 at most), and keep it.
 */
export const roomyProbeMaxOutputTokens = 16_000;
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

/** describeTools names each provider tool a request carries, with its
 * arguments: the tool is part of the method. */
export const describeTools = (tools: Record<string, unknown>) => {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    id: isRecord(tool) ? tool.id : undefined,
    args: isRecord(tool) ? tool.args : undefined,
  }));
};

/** The market an adapter's search tool is asked to search, when the tool
 * takes one. The providers' own tools take none. */
export type SearchMarket = { geography: string; language: string };

type GatewayChatMethod = {
  profile: ProbeAdapterProfile;
  /** The output tokens one call may use: the follow-up gets the same. */
  maxOutputTokens: number;
  /** Built per call, as the request carries it. */
  tools: (market: SearchMarket | undefined) => Record<string, unknown>;
  extractRetrieval: (result: SearchProbeResult) => RetrievalLog;
};

const searchRequest = ({
  model,
  promptText,
  maxOutputTokens,
  tools,
}: {
  model: string;
  promptText: string;
  maxOutputTokens: number;
  tools: Record<string, unknown>;
}): ProbeRequest => {
  return {
    prompt: `${searchPromptPrefix}${promptText}`,
    parameters: {
      model,
      maxOutputTokens,
      toolChoice: 'required',
      tools: describeTools(tools),
    },
  };
};

const searchProbe = async ({
  surface,
  gateway,
  model,
  promptText,
  method,
  tools: toolsOf,
}: {
  surface: AeoApiSurface;
  gateway: ChatModelProvider;
  model: string;
  promptText: string;
  method: GatewayChatMethod;
  /** The method's tools, in the adapter's market. */
  tools: () => Record<string, unknown>;
}): Promise<ProbeAnswer> => {
  const tools = toolsOf();
  const { maxOutputTokens } = method;
  const { prompt } = searchRequest({
    model,
    promptText,
    maxOutputTokens,
    tools,
  });
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
    maxOutputTokens,
    tools: toProviderToolSet(tools),
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
    maxOutputTokens,
    tools: toProviderToolSet(toolsOf()),
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
      fromFollowUp: true,
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
  retrieval: ProbeAdapterProfile['observes']['retrieval'],
): ProbeAdapterProfile => {
  return {
    id,
    observes: { retrieval, servedModel: 'compare_to_requested' },
    settings: [{ name: 'AI_GATEWAY_API_KEY', secret: true }],
    pool: 'gateway',
    retry: 'chat',
    estimateUsd: probeUsd[id],
    billing: 'metered',
    resolvesRedirects: true,
  };
};

export type GatewayChatAdapterId =
  | typeof ProbeAdapterId.GATEWAY_OPENAI
  | typeof ProbeAdapterId.GATEWAY_OPENAI_2
  | typeof ProbeAdapterId.GATEWAY_GOOGLE
  | typeof ProbeAdapterId.GATEWAY_ANTHROPIC
  | typeof ProbeAdapterId.GATEWAY_ANTHROPIC_2
  | typeof ProbeAdapterId.GATEWAY_SEARCH;

// A two-letter language, alone or with its region ("pt", "pt-BR").
const languageOfMarket = /^([a-z]{2})(?:-[a-z]{2})?$/;

// The gateway's search tool, in the audit's market: results for the
// country, in the language. Both are two-letter codes there. A regional
// variant is searched by its language; anything else is left out, never
// guessed.
const gatewaySearchTool = (market: SearchMarket | undefined) => {
  const country = market?.geography.toUpperCase();
  const language = languageOfMarket.exec(
    market?.language.toLowerCase() ?? '',
  )?.[1];

  return gatewaySdk.tools.perplexitySearch({
    ...(country !== undefined && /^[A-Z]{2}$/.test(country) && { country }),
    ...(language !== undefined && { searchLanguageFilter: [language] }),
  });
};

const gatewayChatMethods: Record<GatewayChatAdapterId, GatewayChatMethod> = {
  // Kept as released: a run directory that froze it resumes on it.
  [ProbeAdapterId.GATEWAY_OPENAI]: {
    profile: gatewayChatProfile(ProbeAdapterId.GATEWAY_OPENAI, 'full'),
    maxOutputTokens: probeMaxOutputTokens,
    tools: () => ({ web_search: openai.tools.webSearch({}) }),
    extractRetrieval: (result) => extractOpenAiRetrieval(result.steps),
  },
  [ProbeAdapterId.GATEWAY_OPENAI_2]: {
    profile: gatewayChatProfile(ProbeAdapterId.GATEWAY_OPENAI_2, 'full'),
    maxOutputTokens: roomyProbeMaxOutputTokens,
    tools: () => ({ web_search: openai.tools.webSearch({}) }),
    extractRetrieval: (result) => extractOpenAiRetrieval(result.steps),
  },
  [ProbeAdapterId.GATEWAY_GOOGLE]: {
    profile: gatewayChatProfile(ProbeAdapterId.GATEWAY_GOOGLE, 'partial'),
    maxOutputTokens: probeMaxOutputTokens,
    tools: () => ({ google_search: google.tools.googleSearch({}) }),
    extractRetrieval: (result) =>
      extractGeminiRetrieval(result.providerMetadata),
  },
  // Kept as released, like gateway.openai@1.
  [ProbeAdapterId.GATEWAY_ANTHROPIC]: {
    profile: gatewayChatProfile(ProbeAdapterId.GATEWAY_ANTHROPIC, 'full'),
    maxOutputTokens: probeMaxOutputTokens,
    tools: () => ({
      web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }),
    }),
    extractRetrieval: (result) => extractAnthropicRetrieval(result.steps),
  },
  [ProbeAdapterId.GATEWAY_ANTHROPIC_2]: {
    profile: gatewayChatProfile(ProbeAdapterId.GATEWAY_ANTHROPIC_2, 'full'),
    maxOutputTokens: roomyProbeMaxOutputTokens,
    tools: () => ({
      web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }),
    }),
    extractRetrieval: (result) => extractAnthropicRetrieval(result.steps),
  },
  // Any gateway model (open models spec §5.2): the search is the gateway's
  // own tool, so it does not depend on the model's provider. Any model may
  // reason, so it has the room from its first release.
  [ProbeAdapterId.GATEWAY_SEARCH]: {
    profile: gatewayChatProfile(ProbeAdapterId.GATEWAY_SEARCH, 'full'),
    maxOutputTokens: roomyProbeMaxOutputTokens,
    tools: (market) => ({ [gatewaySearchToolName]: gatewaySearchTool(market) }),
    extractRetrieval: (result) => extractGatewaySearchRetrieval(result.steps),
  },
};

export const gatewayChatProfiles = {
  [ProbeAdapterId.GATEWAY_OPENAI]:
    gatewayChatMethods[ProbeAdapterId.GATEWAY_OPENAI].profile,
  [ProbeAdapterId.GATEWAY_OPENAI_2]:
    gatewayChatMethods[ProbeAdapterId.GATEWAY_OPENAI_2].profile,
  [ProbeAdapterId.GATEWAY_GOOGLE]:
    gatewayChatMethods[ProbeAdapterId.GATEWAY_GOOGLE].profile,
  [ProbeAdapterId.GATEWAY_ANTHROPIC]:
    gatewayChatMethods[ProbeAdapterId.GATEWAY_ANTHROPIC].profile,
  [ProbeAdapterId.GATEWAY_ANTHROPIC_2]:
    gatewayChatMethods[ProbeAdapterId.GATEWAY_ANTHROPIC_2].profile,
  [ProbeAdapterId.GATEWAY_SEARCH]:
    gatewayChatMethods[ProbeAdapterId.GATEWAY_SEARCH].profile,
} satisfies Record<GatewayChatAdapterId, ProbeAdapterProfile>;

/** createGatewayChatAdapter is one search-required chat adapter, asking
 * `model` on `surface` through the run's `gateway`. */
export const createGatewayChatAdapter = (
  id: GatewayChatAdapterId,
  {
    surface,
    gateway,
    model,
    market,
  }: {
    surface: AeoApiSurface;
    gateway: ChatModelProvider;
    model: string;
    market?: SearchMarket;
  },
): ProbeAdapter => {
  const method: GatewayChatMethod = gatewayChatMethods[id];
  const tools = () => method.tools(market);

  const adapter: ProbeAdapter = {
    ...method.profile,
    surface,
    model,
    request: (promptText) =>
      searchRequest({
        model,
        promptText,
        maxOutputTokens: method.maxOutputTokens,
        tools: tools(),
      }),
    probe: (promptText) =>
      searchProbe({ surface, gateway, model, promptText, method, tools }),
    classifyError: classifyGatewayFailure,
  };

  return adapter;
};
