import { z } from 'zod';
import {
  requireWorkerTransport,
  workerTransport,
} from '../../container/protocol';
import { readEnv } from '../../lib/env';
import { retrievalLogSchema } from '../../schema';
import type { AeoAgentSurface } from '../../surfaces';
import type {
  ProbeAdapter,
  ProbeAdapterProfile,
  ProbeAnswer,
} from '../adapter';
import { claudeCodeProfile, runClaudeCodeProbe } from './cli-claude-code';
import { codexProfile, runCodexProbe } from './cli-codex';
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

/** probeForSurface is how a CLI run happens here: through the worker
 * transport when one is installed, else on this machine. */
export const probeForSurface = (surface: AeoAgentSurface): AgentProbeFn => {
  const transport = workerTransport();

  if (transport) {
    return async (prompt, runtime, signal) => {
      const answer = await transport.invoke(
        surface,
        {
          task: 'probe',
          prompt,
          timeoutMs: Math.min(
            runtime.timeoutMs ?? agentProbeTimeoutMs,
            300_000,
          ),
        },
        signal,
      );

      return agentAnswerSchema.parse(answer);
    };
  }

  if (readEnv('AEO_ISOLATED_ADAPTER') === '1') {
    requireWorkerTransport();
  }

  switch (surface) {
    case 'claude_code':
      return runClaudeCodeProbe;
    case 'codex':
      return runCodexProbe;
    case 'cursor':
      return runCursorProbe;
  }
};

/**
 * createCliAdapter is the adapter of `surface`'s CLI, running each attempt
 * through `run` with `runtime`.
 */
export const createCliAdapter = (
  surface: AeoAgentSurface,
  { run, runtime }: { run: AgentProbeFn; runtime: AgentRuntime },
): ProbeAdapter => {
  const adapter: ProbeAdapter = {
    ...cliAdapterProfiles[surface],
    surface,
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
