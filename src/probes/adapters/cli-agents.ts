import { z } from 'zod';
import { retrievalLogSchema } from '../../schema';
import type { AeoAgentSurface } from '../../surfaces';
import type {
  ProbeAdapter,
  ProbeAdapterProfile,
  ProbeAnswer,
} from '../adapter';
import { claudeCodeProfile, runClaudeCodeProbe } from './cli-claude-code';
import {
  codexProfile,
  codexRequestParameters,
  runCodexProbe,
} from './cli-codex';
import { cursorProfile, runCursorProbe } from './cli-cursor';
import {
  agentProbeTimeoutMs,
  classifyAgentError,
  type AgentProbeFn,
  type AgentRuntime,
} from './cli-process';

// ============================================================================
// The coding-agent CLI adapters (cli.claude_code, cli.codex, cli.cursor):
// one CLI run per attempt, on this machine or, in the hosted platform,
// through the isolated worker transport. The answer is the CLI's own final
// message; whether a web tool ran and what it retrieved come from the CLI's
// structured events, never from the answer text.
// ============================================================================

export const cliAdapterProfiles = {
  claude_code: claudeCodeProfile,
  codex: codexProfile,
  cursor: cursorProfile,
} satisfies Record<AeoAgentSurface, ProbeAdapterProfile>;

// What a worker sends back for a probe or a version request.
const agentAnswerSchema = z.object({
  text: z.string(),
  usedWebSearch: z.boolean().nullable(),
  retrieval: retrievalLogSchema,
  requestedModel: z.string().nullable().optional(),
  reportedModel: z.string().optional(),
});

// What a CLI probe's request records beyond its prompt: the CLI, and for
// Codex the model and sandbox it is started with.
const requestParameters: Readonly<
  Record<AeoAgentSurface, (env: NodeJS.ProcessEnv) => Record<string, unknown>>
> = {
  claude_code: () => ({ cli: 'claude' }),
  codex: codexRequestParameters,
  cursor: () => ({ cli: 'cursor-agent' }),
};

const localProbes: Readonly<Record<AeoAgentSurface, AgentProbeFn>> = {
  claude_code: runClaudeCodeProbe,
  codex: runCodexProbe,
  cursor: runCursorProbe,
};

/** probeForSurface is one CLI run: through the runtime's worker transport
 * when it has one, else on this machine. */
export const probeForSurface = (surface: AeoAgentSurface): AgentProbeFn => {
  return async (prompt, runtime, signal) => {
    if (!runtime.transport) {
      return localProbes[surface](prompt, runtime, signal);
    }

    const answer = await runtime.transport.invoke(
      surface,
      {
        task: 'probe',
        prompt,
        timeoutMs: Math.min(runtime.timeoutMs ?? agentProbeTimeoutMs, 300_000),
      },
      signal,
    );

    return agentAnswerSchema.parse(answer);
  };
};

/**
 * createCliAdapter is the adapter of `surface`'s CLI, running each attempt
 * with `runtime`: its environment, its config directory, its deadline and,
 * hosted, its worker transport.
 */
export const createCliAdapter = (
  surface: AeoAgentSurface,
  { runtime }: { runtime: AgentRuntime },
): ProbeAdapter => {
  const run = probeForSurface(surface);

  const adapter: ProbeAdapter = {
    ...cliAdapterProfiles[surface],
    surface,
    request: (promptText) => ({
      prompt: promptText,
      parameters: requestParameters[surface](runtime.env),
    }),
    probe: async (promptText, { signal }) => {
      const answer = await run(promptText, runtime, signal);
      const probeAnswer: ProbeAnswer = {
        answerText: answer.text,
        sources: { format: 'none' },
        retrieval: answer.retrieval,
        usedWebSearch: answer.usedWebSearch,
        ...(answer.requestedModel !== undefined && {
          requestedModel: answer.requestedModel,
        }),
        ...(answer.reportedModel !== undefined && {
          servedModel: answer.reportedModel,
        }),
      };

      return probeAnswer;
    },
    classifyError: classifyAgentError,
  };

  return adapter;
};
