import { streamText, type ToolSet } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { anthropic } from '@ai-sdk/anthropic';
import type { AeoChatSurface, AeoSurface, RetrievalLog } from '../schema';
import { chatSurfaces, surfaceRunCounts } from '../schema';
import { surfaceRetrievalExposure } from '../retrieval';
import { createLog } from '../lib/log';
import { servedModelOf } from '../models/served-model';
import {
  endAttempt,
  ProbeTraceError,
  startAttempt,
  type ProbeAttemptHandle,
  type ProbeTrace,
} from './probe-trace';
import { getGoogleAIOverview } from './dataforseo';
import {
  extractAnthropicRetrieval,
  extractGeminiRetrieval,
  extractOpenAiRetrieval,
  retrievalResultUrls,
  rewriteRetrievalUrls,
  type RetrievalStep,
} from './chat-retrieval';
import {
  extractGroundingRedirectUrls,
  isGroundingRedirectUrl,
  resolveGroundingRedirects,
  rewriteTextUrls,
} from './grounding-urls';
import {
  ProbeFailure,
  classifyGatewayError,
  errorMessage,
  retryDelayMs,
  type ProbeFailureKind,
} from './failure';
import {
  sleep,
  unlimited,
  type ProbeLimiter,
  type ProbeProvider,
} from './limits';
import type { ProbeOutcome, ProbeUnitRef } from './outcomes';

const log = createLog('AISearchProbes');
const probeMaxOutputTokens = 2000;
// A search-required call plus a synthesis follow-up: bounded by the runner
// (hardening spec §4.5), never by undici's defaults plus SDK retries.
const chatProbeTimeoutMs = 180_000;

// Probe model IDs — the console's canonical aiSearchProbeModels. Changing
// a model resets baseline comparability for that surface; call it out in the
// report's methodology note if you must.
export const aiSearchProbeModels: Record<
  Exclude<AeoChatSurface, 'google_ai_overview'>,
  string
> = {
  chatgpt: 'openai/gpt-5.4-mini',
  gemini: 'google/gemini-3-flash',
  claude: 'anthropic/claude-sonnet-4.5',
  perplexity: 'perplexity/sonar-pro',
};

// The model a chat surface asks for; Google AI Overview is a SERP feature
// with no model to request.
const chatProbeRequestedModel = (surface: AeoChatSurface): string | null => {
  return surface === 'google_ai_overview' ? null : aiSearchProbeModels[surface];
};

// Public probe result shape. Consumers carry these into the analyzer +
// scorecard pipelines.
export type ProbeResult = {
  promptId: string;
  promptText: string;
  promptCategory: string;
  modelName: AeoSurface;
  runIndex: number;
  text: string;
  // Retrieval log (retrieval-log spec §4): the searches and fetches behind
  // the answer, set on every fresh probe (`exposure: 'none'` included).
  // Absent = not captured: a checkpointed probe from before the spec, or an
  // extractor miss on a surface whose SDK guaranteed a call (§7). Absent
  // is never a from-memory claim.
  retrieval?: RetrievalLog;
  // Google AI Overview only (hardening spec §4.1): the SERP came back with
  // no AI Overview. An honest absence — the brand was not visible — stored
  // as a typed outcome with empty text, never as sentinel prose the analyzer
  // has to read.
  noOverview?: true;
  // The model the provider says answered, when it names one other than the
  // requested model (servedModelOf). Absent means not reported, never "the
  // requested model answered".
  reportedModel?: string;
};

export type ProbePromptInput = {
  // Stable id used to group probes back by prompt for analysis.
  id: string;
  promptText: string;
  // Category is opaque here — it flows through to the scorecard's
  // by-category breakdown but the probe loop doesn't read it.
  category: string;
};

export type ChatProbeOutcome = ProbeOutcome<ProbeResult>;

export type ProbeJob = {
  geography: string;
  language: string;
  prompts: ProbePromptInput[];
  // Which chat surfaces to run — defaults to all five. Lets `--surfaces`
  // iterate cheaply without touching the canonical run counts.
  surfaces?: readonly AeoChatSurface[];
  // Unit-level gate for store resume: return false to skip a planned
  // (prompt × surface × run) execution. Omitted = run everything.
  filter?: (unit: {
    promptId: string;
    surface: AeoChatSurface;
    runIndex: number;
  }) => boolean;
  // Called with each captured probe as soon as it is usable (redirects
  // resolved), so the caller banks it before the batch ends. A throwing
  // banker turns the unit into a `persistence` failure; the probe is never
  // re-executed (§4.2).
  onResult?: (result: ProbeResult) => Promise<void>;
  // The run journal: each attempt is an operation (probe-trace.ts).
  trace?: ProbeTrace;
  // Per-provider pools (§4.5); unbounded when omitted (tests).
  limiter?: ProbeLimiter;
  // Aborting stops dispatch; units already running finish their attempt.
  signal?: AbortSignal;
};

// What one probe execution yields: the answer text and its retrieval log,
// null when the log could not be extracted (stored as "not captured").
type ProbeAnswer = {
  text: string;
  retrieval: RetrievalLog | null;
  noOverview?: true;
  reportedModel?: string;
};

type ProbeModelConfig = {
  name: AeoChatSurface;
  runs: number;
  provider: ProbeProvider;
  probe: (promptText: string) => Promise<ProbeAnswer>;
};

const searchPromptPrefix =
  'Search the web for current information to answer the following question. Return a complete answer, not just search results.\n\n';

const formatProbeSources = (sources: readonly unknown[]): string => {
  const rows: string[] = [];

  for (const source of sources) {
    if (
      !source ||
      typeof source !== 'object' ||
      !('sourceType' in source) ||
      source.sourceType !== 'url' ||
      !('url' in source) ||
      typeof source.url !== 'string'
    ) {
      continue;
    }

    const title =
      'title' in source && typeof source.title === 'string'
        ? source.title
        : source.url;

    rows.push(`- ${title}: ${source.url}`);
  }

  return rows.length > 0 ? `Sources used by search:\n${rows.join('\n')}` : '';
};

const withProbeSources = (
  text: string,
  sources: readonly unknown[],
): string => {
  const sourceList = formatProbeSources(sources);

  if (!sourceList) {
    return text;
  }

  return `${text.trim()}\n\n${sourceList}`;
};

// The slice of a model result the retrieval extractors read.
type SearchProbeResult = {
  steps: ReadonlyArray<RetrievalStep>;
  providerMetadata: unknown;
};

/**
 * toProviderToolSet hands provider-defined tools to `streamText`.
 */
const toProviderToolSet = (tools: Record<string, unknown>): ToolSet => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- The provider packages declare their tools against a different Tool type than the `ai` package.
  return tools as ToolSet;
};

const runSearchRequiredProbe = async (args: {
  modelName: AeoSurface;
  modelId: string;
  promptText: string;
  tools: Record<string, unknown>;
  extractRetrieval: (result: SearchProbeResult) => RetrievalLog;
}): Promise<ProbeAnswer> => {
  const prompt = `${searchPromptPrefix}${args.promptText}`;
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
    model: gateway(args.modelId),
    prompt,
    maxOutputTokens: probeMaxOutputTokens,
    tools: toProviderToolSet(args.tools),
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

  const first = {
    steps,
    text,
    sources,
    finishReason,
    toolCalls,
    response,
    providerMetadata,
  };

  // The retrieval log comes from this first, search-required call only; the
  // synthesis follow-up below runs with toolChoice: 'none' and contributes
  // nothing. An empty log after a required tool call is an extractor miss
  // (§7), not a from-memory answer: log it and store no retrieval, so the
  // row renders "not captured" rather than "no searches".
  let retrieval: RetrievalLog | null = args.extractRetrieval(first);
  const reportedModel = servedModelOf(args.modelId, first.response.modelId);
  const served = reportedModel === undefined ? {} : { reportedModel };

  if (retrieval.calls.length === 0) {
    log.warn('Search-required probe yielded no retrieval calls; not stored', {
      model: args.modelName,
      stepCount: first.steps.length,
      partTypes: [
        ...new Set(
          first.steps.flatMap((step) => step.content.map((p) => p.type)),
        ),
      ],
    });

    retrieval = null;
  }

  if (first.text.trim().length > 0) {
    return {
      text: withProbeSources(first.text, first.sources),
      retrieval,
      ...served,
    };
  }

  log.warn('Search probe returned no answer text; synthesizing from search', {
    model: args.modelName,
    finishReason: first.finishReason,
    toolCallCount: first.toolCalls.length,
    sourceCount: first.sources.length,
  });

  // The follow-up is its own stream with its own failure: a 429 here is
  // capacity, to be retried as such, and must not be read through the
  // first stream's error or mistaken for a parser slip.
  let followupFailure: unknown;
  const followupStream = streamText({
    onError: ({ error }) => {
      followupFailure ??= error;
    },
    model: gateway(args.modelId),
    messages: [
      { role: 'user', content: prompt },
      ...first.response.messages,
      {
        role: 'user',
        content:
          'Using the web search results from the previous turn, answer the original question in a complete, readable response. Do not perform another search. If the search results were insufficient, say what was missing.',
      },
    ],
    maxOutputTokens: probeMaxOutputTokens,
    tools: toProviderToolSet(args.tools),
    toolChoice: 'none',
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(chatProbeTimeoutMs),
  });

  const [followupText, followupSources] = await Promise.all([
    followupStream.text,
    followupStream.sources,
  ]).catch((error: unknown) => {
    throw followupFailure ?? error;
  });

  const followup = { text: followupText, sources: followupSources };

  if (followup.text.trim().length > 0) {
    return {
      text: withProbeSources(
        followup.text,
        first.sources.length > 0 ? first.sources : followup.sources,
      ),
      retrieval,
      ...served,
    };
  }

  // No answer after the search and the synthesis follow-up: a failed unit
  // (hardening spec §2.4), retried like a transient failure — never banked
  // as a measured absence.
  throw new ProbeFailure(
    'empty_answer',
    `${args.modelName} completed a required web search but returned no answer text (tool calls: ${first.toolCalls.length}, sources: ${first.sources.length})`,
  );
};

// Surfaces that structurally expose no retrieval (§2): Perplexity and Google
// AI Overview. Their logs are honest "nothing exposed" records, never
// "not captured".
const unexposedRetrieval = (surface: AeoChatSurface): RetrievalLog => {
  return { exposure: surfaceRetrievalExposure[surface], calls: [] };
};

// Builds the 5-surface probe configuration. The list and per-surface run
// counts are the canonical console behavior — run counts live in
// surfaceRunCounts (schema.ts) so scoring denominators stay in sync.
const buildProbeModels = (args: {
  geography: string;
  language: string;
  surfaces: readonly AeoChatSurface[];
}): ProbeModelConfig[] => {
  const all: ProbeModelConfig[] = [
    {
      name: 'chatgpt',
      runs: surfaceRunCounts.chatgpt,
      provider: 'gateway',
      probe: async (promptText) => {
        return runSearchRequiredProbe({
          modelName: 'chatgpt',
          modelId: aiSearchProbeModels.chatgpt,
          promptText,
          tools: { web_search: openai.tools.webSearch({}) },
          extractRetrieval: (result) => extractOpenAiRetrieval(result.steps),
        });
      },
    },
    {
      name: 'gemini',
      runs: surfaceRunCounts.gemini,
      provider: 'gateway',
      probe: async (promptText) => {
        return runSearchRequiredProbe({
          modelName: 'gemini',
          modelId: aiSearchProbeModels.gemini,
          promptText,
          tools: { google_search: google.tools.googleSearch({}) },
          extractRetrieval: (result) =>
            extractGeminiRetrieval(result.providerMetadata),
        });
      },
    },
    {
      name: 'claude',
      runs: surfaceRunCounts.claude,
      provider: 'gateway',
      probe: async (promptText) => {
        return runSearchRequiredProbe({
          modelName: 'claude',
          modelId: aiSearchProbeModels.claude,
          promptText,
          tools: {
            web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }),
          },
          extractRetrieval: (result) => extractAnthropicRetrieval(result.steps),
        });
      },
    },
    {
      name: 'perplexity',
      runs: surfaceRunCounts.perplexity,
      provider: 'gateway',
      probe: async (promptText) => {
        // Perplexity cites with bare numeric markers ([1], [2]) and returns
        // the URLs behind them out-of-band in `sources` — append them like
        // the other search surfaces so citation extraction sees them.
        let streamFailure: unknown;
        const stream = streamText({
          onError: ({ error }) => {
            streamFailure ??= error;
          },
          model: gateway(aiSearchProbeModels.perplexity),
          prompt: `${searchPromptPrefix}${promptText}`,
          maxOutputTokens: probeMaxOutputTokens,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(chatProbeTimeoutMs),
        });

        const result = await Promise.all([
          stream.text,
          stream.sources,
          stream.response,
        ])
          .then(([text, sources, response]) => ({ text, sources, response }))
          .catch((error: unknown) => {
            throw streamFailure ?? error;
          });

        if (result.text.trim().length === 0) {
          throw new ProbeFailure(
            'empty_answer',
            'perplexity returned no answer text',
          );
        }

        const reportedModel = servedModelOf(
          aiSearchProbeModels.perplexity,
          result.response.modelId,
        );

        return {
          text: withProbeSources(result.text, result.sources),
          retrieval: unexposedRetrieval('perplexity'),
          ...(reportedModel === undefined ? {} : { reportedModel }),
        };
      },
    },
    {
      name: 'google_ai_overview',
      runs: surfaceRunCounts.google_ai_overview,
      provider: 'dataforseo',
      probe: async (promptText) => {
        const retrieval = unexposedRetrieval('google_ai_overview');
        const result = await getGoogleAIOverview(
          promptText,
          args.geography,
          args.language,
        );

        if (result.status === 'no_overview') {
          return { text: '', retrieval, noOverview: true };
        }

        let text = result.markdown;

        if (result.references.length > 0) {
          text += '\n\nSources cited in AI Overview:\n';
          text += result.references
            .map((r) => {
              // Wrapped references (google.com/goto) report domain
              // "google.com" for every source; the URL is resolved to its
              // real target after the call, so the misleading label is
              // dropped rather than printed next to it.
              const domainLabel = isGroundingRedirectUrl(r.url)
                ? ''
                : ` (${r.domain})`;

              return `- ${r.source}${domainLabel}: "${r.title}" — ${r.url}`;
            })
            .join('\n');
        }

        if (text.trim().length === 0) {
          throw new ProbeFailure(
            'empty_answer',
            'google_ai_overview returned an AI Overview with no text',
          );
        }

        return { text, retrieval };
      },
    },
  ];

  return all.filter((m) => args.surfaces.includes(m.name));
};

// Normalize captured text before any consumer sees it:
//  - strip U+0000 so JSON snapshot files stay portable;
//  - resolve Gemini grounding redirects to their real targets, so the
//    analyzer detects citations by true domain and every persisted
//    excerpt/cited-URL derives from readable sources. Retrieval result
//    sets go through the same map, so no wrapper reaches attribution.
// Per unit (§4.5): a probe banks the moment its own redirects resolve,
// never after the whole batch.
const finalizeAnswer = async (
  answer: ProbeAnswer,
  logContext: Record<string, unknown> | undefined,
): Promise<ProbeAnswer> => {
  const text = answer.text.replaceAll('\u0000', '');
  const resolved = await resolveGroundingRedirects(
    [
      ...extractGroundingRedirectUrls(text),
      ...(answer.retrieval ? retrievalResultUrls(answer.retrieval) : []),
    ],
    logContext,
  );

  return {
    ...answer,
    text: rewriteTextUrls(text, resolved),
    retrieval: answer.retrieval
      ? rewriteRetrievalUrls(answer.retrieval, resolved)
      : null,
  };
};

/**
 * Runs every planned chat probe (prompt × surface × run) through the
 * provider pools and returns one outcome per unit: a captured probe, or a
 * typed failure after the retry policy is spent (§4.1, §4.6). Nothing is
 * dropped: a unit the caller banks (`onResult`) that fails to persist is a
 * `persistence` failure, not a re-executed probe.
 */
export const runProbesForPrompts = async (
  job: ProbeJob,
  opts: { logContext?: Record<string, unknown> } = {},
): Promise<ChatProbeOutcome[]> => {
  const probeModels = buildProbeModels({
    geography: job.geography,
    language: job.language,
    surfaces: job.surfaces ?? chatSurfaces,
  });

  const limiter = job.limiter ?? unlimited();

  const tasks: Promise<ChatProbeOutcome>[] = [];

  for (const prompt of job.prompts) {
    for (const model of probeModels) {
      for (let run = 1; run <= model.runs; run++) {
        const unit: ProbeUnitRef = {
          promptId: prompt.id,
          surface: model.name,
          runIndex: run,
        };

        if (
          job.filter &&
          !job.filter({
            promptId: prompt.id,
            surface: model.name,
            runIndex: run,
          })
        ) {
          continue;
        }

        tasks.push(
          runChatUnit(unit, {
            prompt,
            model,
            limiter,
            job,
            logContext: opts.logContext,
          }),
        );
      }
    }
  }

  const outcomes = await Promise.all(tasks);
  const captured = outcomes.filter((o) => o.status === 'captured').length;
  log.info('Probes completed', {
    ...opts.logContext,
    planned: outcomes.length,
    captured,
    failed: outcomes.length - captured,
  });

  return outcomes;
};

type ChatUnitOptions = {
  prompt: ProbePromptInput;
  model: ProbeModelConfig;
  limiter: ProbeLimiter;
  job: ProbeJob;
  logContext: Record<string, unknown> | undefined;
};

const runChatUnit = async (
  unit: ProbeUnitRef,
  { prompt, model, limiter, job, logContext }: ChatUnitOptions,
): Promise<ChatProbeOutcome> => {
  const context = {
    ...logContext,
    model: model.name,
    promptId: prompt.id,
    run: unit.runIndex,
  };

  let attempt = 0;
  let answer: ProbeAnswer | null = null;
  let lastKind: ProbeFailureKind = 'cli_error';
  let lastError = '';
  let traced: ProbeAttemptHandle | undefined;

  for (;;) {
    if (job.signal?.aborted) {
      return {
        status: 'failed',
        unit,
        kind: 'timeout',
        attempts: attempt,
        lastError: 'run aborted before the unit executed',
      };
    }

    attempt += 1;
    const startedAt = Date.now();
    const retryOf = traced?.id;

    traced = undefined;

    try {
      const raw = await limiter.run(model.provider, async () => {
        // Opened inside the pool slot, so the operation starts when the
        // request does, and before it: no paid dispatch goes unrecorded.
        traced = await startAttempt(job.trace, {
          surface: model.name,
          promptId: prompt.id,
          promptText: prompt.promptText,
          runIndex: unit.runIndex,
          attempt,
          ...(retryOf === undefined ? {} : { retryOf }),
          requestedModel: chatProbeRequestedModel(model.name),
        });

        return model.probe(prompt.promptText);
      });

      answer = await finalizeAnswer(raw, logContext);
      log.debug('Probe completed', {
        ...context,
        attempt,
        durationMs: Date.now() - startedAt,
        chars: answer.text.length,
        ...(answer.noOverview ? { noOverview: true } : {}),
      });

      break;
    } catch (error) {
      if (error instanceof ProbeTraceError) {
        return {
          status: 'failed',
          unit,
          kind: 'persistence',
          attempts: attempt,
          lastError: error.message,
        };
      }

      lastKind = classifyGatewayError(error);
      lastError = errorMessage(error);

      const unrecorded = await endAttempt(traced, {
        outcome: job.signal?.aborted ? 'cancelled' : 'failed',
        kind: lastKind,
        error: lastError,
      });

      if (unrecorded !== null) {
        return {
          status: 'failed',
          unit,
          kind: 'persistence',
          attempts: attempt,
          lastError: unrecorded,
        };
      }

      const delayMs = retryDelayMs(lastKind, attempt);
      log.warn(delayMs === null ? 'Probe failed' : 'Probe failed; retrying', {
        ...context,
        attempt,
        kind: lastKind,
        durationMs: Date.now() - startedAt,
        ...(delayMs === null ? {} : { retryInMs: delayMs }),
        error: lastError,
      });

      if (delayMs === null) {
        return {
          status: 'failed',
          unit,
          kind: lastKind,
          attempts: attempt,
          lastError,
        };
      }

      await sleep(delayMs, job.signal);
    }
  }

  const unrecorded = await endAttempt(traced, {
    outcome: 'succeeded',
    text: answer.text,
    retrieval: answer.retrieval,
    requestedModel: chatProbeRequestedModel(model.name),
    ...(answer.reportedModel ? { reportedModel: answer.reportedModel } : {}),
    ...(answer.noOverview ? { noOverview: true as const } : {}),
  });

  if (unrecorded !== null) {
    return {
      status: 'failed',
      unit,
      kind: 'persistence',
      attempts: attempt,
      lastError: unrecorded,
    };
  }

  const probe: ProbeResult = {
    promptId: prompt.id,
    promptText: prompt.promptText,
    promptCategory: prompt.category,
    modelName: model.name,
    runIndex: unit.runIndex,
    text: answer.text,
    ...(answer.retrieval ? { retrieval: answer.retrieval } : {}),
    ...(answer.noOverview ? { noOverview: true as const } : {}),
    ...(answer.reportedModel ? { reportedModel: answer.reportedModel } : {}),
  };

  // Banking sits outside the attempt loop: a writer that throws must never
  // re-run a paid probe (§4.2).
  try {
    await job.onResult?.(probe);
  } catch (error) {
    const message = errorMessage(error);
    log.error('Probe captured but could not be persisted', error, context);

    return {
      status: 'failed',
      unit,
      kind: 'persistence',
      attempts: attempt,
      lastError: message,
    };
  }

  return { status: 'captured', unit, probe, attempts: attempt };
};
