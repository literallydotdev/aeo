import type { AeoChatSurface, ChatProbeConfig, RetrievalLog } from '../schema';
import { chatRunsPerPrompt, chatSurfaces } from '../schema';
import type { AeoSurface } from '../surfaces';
import { createLog } from '../lib/log';
import { attemptRules, runProbeUnit } from './attempt';
import { createChatAdapter, type ProbeDependencies } from './bindings';
import { unlimited, type ProbeLimiter } from './limits';
import type { ProbeOutcome } from './outcomes';
import type { ProbeTrace } from './probe-trace';

// ============================================================================
// Chat-surface probes: every planned (prompt × surface × run) unit through
// the surface's adapter (adapters/gateway-chat.ts, gateway-perplexity.ts,
// dataforseo-ai-overview.ts) and the host's attempt loop (attempt.ts).
// ============================================================================

const log = createLog('AISearchProbes');

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
  // Runs per prompt; undefined = the canonical surfaceRunCounts. Must be
  // the depth the plan was built with, or resume and scoring disagree.
  chatProbes: ChatProbeConfig | undefined;
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
  // What the adapters are created with: the gateway, credentials, clients.
  dependencies: ProbeDependencies;
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
  const selected = job.surfaces ?? chatSurfaces;
  // Canonical surface order, whatever order the job names them in. Run
  // counts come from chatRunsPerPrompt (schema.ts), the rule the plan and
  // the scoring denominators read too.
  const probed = chatSurfaces
    .filter((surface) => selected.includes(surface))
    .map((surface) => ({
      surface,
      runs: chatRunsPerPrompt(surface, job.chatProbes),
      adapter: createChatAdapter(surface, {
        geography: job.geography,
        language: job.language,
        dependencies: job.dependencies,
      }),
    }));
  const limiter = job.limiter ?? unlimited();

  const tasks: Promise<ChatProbeOutcome>[] = [];

  for (const prompt of job.prompts) {
    for (const { surface, runs, adapter } of probed) {
      for (let run = 1; run <= runs; run++) {
        if (
          job.filter &&
          !job.filter({ promptId: prompt.id, surface, runIndex: run })
        ) {
          continue;
        }

        const unit = {
          promptId: prompt.id,
          promptText: prompt.promptText,
          runIndex: run,
        };

        tasks.push(
          runProbeUnit(adapter, unit, {
            rules: attemptRules.chat,
            trace: job.trace,
            limiter,
            signal: job.signal,
            log,
            logContext: {
              ...opts.logContext,
              model: surface,
              promptId: prompt.id,
              run,
            },
            toResult: (answer): ProbeResult => ({
              promptId: prompt.id,
              promptText: prompt.promptText,
              promptCategory: prompt.category,
              modelName: surface,
              runIndex: run,
              text: answer.text,
              ...(answer.retrieval ? { retrieval: answer.retrieval } : {}),
              ...(answer.noOverview ? { noOverview: true as const } : {}),
              ...(answer.reportedModel
                ? { reportedModel: answer.reportedModel }
                : {}),
            }),
            ...(job.onResult && { bank: job.onResult }),
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
