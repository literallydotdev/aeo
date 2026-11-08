import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProtocolModule from '../container/protocol';
import { runCanaryProbe } from './agent-clis';
import { ProbeTraceError, type ProbeTrace } from './probe-trace';

// ============================================================================
// How a canary stops (hardening spec §4.5): unlike a probe unit, a canary
// that was aborted, or whose operation could not be opened, stops the
// preflight by throwing; a canary that answered but could not be recorded
// is a persistence failure of its surface. The CLI is the worker transport,
// faked.
// ============================================================================

const worker = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../container/protocol', async (original) => ({
  ...(await original<typeof ProtocolModule>()),
  workerTransport: () => ({ invoke: worker.invoke }),
}));

const runtime = { env: {}, claudeConfigDir: null };

const answered = {
  text: 'OK',
  usedWebSearch: false,
  retrieval: { exposure: 'full', calls: [] },
};

describe('agent-clis - runCanaryProbe()', () => {
  beforeEach(() => {
    worker.invoke.mockReset();
  });

  it('should throw the abort, asking nothing, when the run was stopped first', async () => {
    const controller = new AbortController();

    controller.abort(new Error('stopped by the operator'));

    const canary = runCanaryProbe('claude_code', runtime, {
      signal: controller.signal,
    });

    await expect(canary).rejects.toThrow('stopped by the operator');
    expect(worker.invoke).not.toHaveBeenCalled();
  });

  it('should throw the journal error, asking nothing, when its operation cannot be opened', async () => {
    const trace: ProbeTrace = {
      start: () => Promise.reject(new Error('read-only file system')),
    };

    const canary = runCanaryProbe('codex', runtime, { trace });

    await expect(canary).rejects.toBeInstanceOf(ProbeTraceError);
    expect(worker.invoke).not.toHaveBeenCalled();
  });

  it('should fail as persistence when its answer cannot be recorded', async () => {
    worker.invoke.mockResolvedValue(answered);
    const trace: ProbeTrace = {
      start: () =>
        Promise.resolve({
          id: 'op-1',
          end: () => Promise.reject(new Error('disk full')),
        }),
    };

    const failure = await runCanaryProbe('cursor', runtime, { trace });

    expect(failure).toEqual({
      kind: 'persistence',
      message: "the probe's outcome could not be recorded: disk full",
      surface: 'cursor',
    });
    expect(worker.invoke).toHaveBeenCalledOnce();
  });
});
