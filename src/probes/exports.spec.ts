import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from './agent-clis';
import * as agentClis from './agent-clis';
import * as agentCliParsers from './agent-cli-parsers';
import * as childProcess from './child-process';
import type { ProbeFailureKind } from './failure';
import * as failure from './failure';
import * as limits from './limits';
import type { PartialFailure } from './web-tool-guard';

// ============================================================================
// The probe subpaths the hosted adapter imports (probe adapters spec §5):
// moving a probe onto the adapter port keeps every one of these names. The
// types are checked by the compiler through the imports above.
// ============================================================================

export type HostedProbeTypes = [AgentRuntime, ProbeFailureKind, PartialFailure];

describe('probes - hosted subpath exports', () => {
  it.each([
    [
      'agent-clis',
      agentClis,
      [
        'assertAgentAuth',
        'assertAgentClis',
        'canaryPrompt',
        'classifyAgentError',
        'cliFailureSignals',
        'cliNameForSurface',
        'defaultAgentRuntime',
        'detectAgentClis',
        'runAgentProbeDirect',
        'runCanaryProbe',
        'runCanaryProbes',
      ],
    ],
    [
      'agent-cli-parsers',
      agentCliParsers,
      ['AgentStreamError', 'RejectedWebToolError'],
    ],
    ['child-process', childProcess, ['ChildProcessError', 'runChild']],
    ['failure', failure, ['ProbeFailure', 'isAuthError', 'isCapacityError']],
    ['limits', limits, ['ProbeLimiter']],
  ] as const)(
    'should keep the names %s exports',
    (_name, module: object, names: readonly string[]) => {
      const missing = names.filter((name) => !(name in module));

      expect(missing).toEqual([]);
    },
  );
});
