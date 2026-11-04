import { z } from 'zod';
import { readEnv } from '../lib/env';
import { isAgentSurface } from '../surfaces';
import type { BundleEvent } from './contracts';

// ============================================================================
// The isolation a run actually had (specs/aeo-open-source-cli-spec.md §4.1,
// specs/aeo-claude-operator-spec.md §4.4). Each writer records its boundary
// when it opens the journal; the sandbox of every Codex stage session and
// every coding-agent probe are already operations in the journal. runtime.json
// reports what those events show and discloses what a native run lacks; a
// writer that recorded nothing is unknown, never assumed isolated.
// ============================================================================

export const IsolationBoundary = {
  NATIVE: 'native',
  CONTAINER: 'container',
} as const;

export type IsolationBoundary =
  (typeof IsolationBoundary)[keyof typeof IsolationBoundary];

export const writerIsolationSchema = z.looseObject({
  boundary: z.enum([IsolationBoundary.NATIVE, IsolationBoundary.CONTAINER]),
  /** The sandbox the Codex probe surface runs in, should it run. */
  codexProbeSandbox: z.string(),
});

export type WriterIsolation = z.infer<typeof writerIsolationSchema>;

/**
 * observedIsolation is this process's boundary: the hosted container runs
 * every agent CLI through an isolated worker under its own UID
 * (AEO_ISOLATED_ADAPTER); anything else runs on the operator's machine as
 * the operator.
 */
export const observedIsolation = (): WriterIsolation => {
  const isolation: WriterIsolation = {
    boundary:
      readEnv('AEO_ISOLATED_ADAPTER') === '1'
        ? IsolationBoundary.CONTAINER
        : IsolationBoundary.NATIVE,
    codexProbeSandbox:
      readEnv('AEO_CODEX_SANDBOX') === 'danger-full-access'
        ? 'danger-full-access'
        : 'read-only',
  };

  return isolation;
};

export type RunIsolation = {
  /** One per writer, in journal order; unknown for a writer from before
   * isolation was recorded. */
  writers: (IsolationBoundary | 'unknown')[];
  /** The Codex stage sessions' sandbox modes, as each session recorded. */
  stageSandboxes: string[];
  /** The agent CLIs probed by a native writer: they ran as the operator's
   * own account, with its account-level settings. */
  agentCliAccounts: string[];
};

const runtimeIsolationOf = (
  event: BundleEvent,
): IsolationBoundary | 'unknown' => {
  const runtime = z
    .looseObject({ isolation: writerIsolationSchema })
    .safeParse(event.payload.runtime);

  return runtime.success ? runtime.data.isolation.boundary : 'unknown';
};

const stringOf = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

const sandboxOf = (event: BundleEvent): string | undefined => {
  const details = z
    .looseObject({ sandbox: z.string() })
    .safeParse(event.payload.details);

  return details.success ? details.data.sandbox : undefined;
};

/** summarizeIsolation reads a run's isolation from its journal events. */
export const summarizeIsolation = (
  events: readonly BundleEvent[],
): RunIsolation => {
  const writers: RunIsolation['writers'] = [];
  const stageSandboxes = new Set<string>();
  const agentCliAccounts = new Set<string>();

  for (const event of events) {
    if (event.type === 'run_started' || event.type === 'run_resumed') {
      writers.push(runtimeIsolationOf(event));
      continue;
    }

    if (event.type !== 'operation_started') {
      continue;
    }

    const kind = stringOf(event.payload.kind);
    const role = stringOf(event.payload.role);
    const sandbox = sandboxOf(event);

    if (kind === 'codex_session' && sandbox !== undefined) {
      stageSandboxes.add(sandbox);
    }

    // A probe belongs to the writer that opened the journal before it.
    const writer = writers.at(-1);

    if (
      (kind === 'probe' || kind === 'canary') &&
      role !== undefined &&
      isAgentSurface(role) &&
      writer !== IsolationBoundary.CONTAINER
    ) {
      agentCliAccounts.add(role);
    }
  }

  const isolation: RunIsolation = {
    writers,
    stageSandboxes: [...stageSandboxes].sort(),
    agentCliAccounts: [...agentCliAccounts].sort(),
  };

  return isolation;
};

/** isolationLimitations states what the recorded isolation does not
 * cover, in plain sentences for runtime.json. */
export const isolationLimitations = (isolation: RunIsolation): string[] => {
  const limitations: string[] = [];

  if (isolation.writers.includes('unknown')) {
    limitations.push(
      'A writer of this run predates isolation recording; its boundary is unknown.',
    );
  }

  if (isolation.writers.includes(IsolationBoundary.NATIVE)) {
    limitations.push(
      "Part or all of this run executed natively, without a container boundary. Codex sandboxes restrict writes and network access, not reads: a Codex session could read any file the operator's account can, while it processed untrusted answers and pages.",
    );
  }

  if (isolation.agentCliAccounts.length > 0) {
    limitations.push(
      `The coding-agent CLIs ${isolation.agentCliAccounts.join(', ')} ran as the operator's own account. Account-level settings outside the tool's control (user rules, approved MCP servers) applied and are not recorded.`,
    );
  }

  return limitations;
};
