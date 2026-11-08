import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProtocolModule from '../container/protocol';
import { WorkerInvocationError } from '../container/protocol';
import { runCanaryProbes } from '../probes/agent-clis';

const mocks = { invoke: vi.fn() };

describe('agent-clis - runCanaryProbes()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());
  // The hosted runtime: every CLI runs behind the worker transport.
  const runtime = {
    env: { NODE_ENV: 'test' as const },
    claudeConfigDir: null,
    transport: {
      has: () => true,
      invoke: mocks.invoke,
      close: () => Promise.resolve(),
    },
  };

  it('should retain capacity after the shared 60-second and 180-second retry ladder', async () => {
    mocks.invoke.mockRejectedValue(new WorkerInvocationError('capacity'));
    const start = Date.now();
    const outcome = runCanaryProbes(['claude_code'], runtime).catch(
      (error: unknown) => error,
    );

    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ kind: 'capacity' });
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(Date.now() - start).toBe(240_000);
  });

  it('should NOT retry a credential failure', async () => {
    mocks.invoke.mockRejectedValue(new WorkerInvocationError('auth'));
    await expect(
      runCanaryProbes(['claude_code'], runtime),
    ).rejects.toMatchObject({ kind: 'auth' });

    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it.each(['auth', 'capacity'] as const)(
    'should retain %s across the bootstrap and adapter module copies',
    async (kind) => {
      // Separate container entry bundles each contain the protocol module.
      vi.resetModules();
      const { WorkerInvocationError: BootstrapError } = await vi.importActual<
        typeof ProtocolModule
      >('../container/protocol');

      expect(BootstrapError).not.toBe(WorkerInvocationError);
      mocks.invoke.mockRejectedValue(new BootstrapError(kind));
      const outcome = runCanaryProbes(['codex'], runtime).catch(
        (error: unknown) => error,
      );

      await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({ kind });
      expect(mocks.invoke).toHaveBeenCalledTimes(kind === 'auth' ? 1 : 3);
    },
  );

  it('should stop a capacity wait on cancellation without dispatching another probe', async () => {
    mocks.invoke.mockRejectedValue(new WorkerInvocationError('capacity'));
    const controller = new AbortController();
    const outcome = runCanaryProbes(['claude_code'], runtime, {
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await vi.runAllTimersAsync();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[2]).toBe(controller.signal);
  });
});
