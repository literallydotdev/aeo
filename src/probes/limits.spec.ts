import { describe, expect, it } from 'vitest';
import { ProbeLimiter, probeLimitsSchema } from './limits';

// ============================================================================
// Per-provider pools (hardening spec §4.5): a provider's pool bounds its own
// concurrency and nothing else's.
// ============================================================================

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

const pause = (delayMs: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
};

describe('limits - ProbeLimiter.run()', () => {
  it('should run at most `size` tasks of one provider at a time', async () => {
    const limiter = new ProbeLimiter(
      probeLimitsSchema.parse({ claude_code: 2 }),
    );

    let active = 0;
    let peak = 0;
    const [firstGate, secondGate, thirdGate] = [
      deferred(),
      deferred(),
      deferred(),
    ];

    const gates = [firstGate, secondGate, thirdGate];
    const tasks = gates.map((gate) =>
      limiter.run('claude_code', async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      }),
    );

    await pause(5);
    expect(active).toBe(2);
    firstGate.resolve();
    await pause(5);
    expect(active).toBe(2);
    secondGate.resolve();
    thirdGate.resolve();
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });

  it('should NOT let one provider block another', async () => {
    const limiter = new ProbeLimiter(
      probeLimitsSchema.parse({ claude_code: 1, codex: 1 }),
    );

    const gate = deferred();
    const claude = limiter.run('claude_code', () => gate.promise);
    const codex = await limiter.run('codex', () => Promise.resolve('ran'));
    expect(codex).toBe('ran');
    gate.resolve();
    await claude;
  });

  it('should release the slot when the task throws', async () => {
    const limiter = new ProbeLimiter(probeLimitsSchema.parse({ gateway: 1 }));
    await expect(
      limiter.run('gateway', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(await limiter.run('gateway', () => Promise.resolve('next'))).toBe(
      'next',
    );
  });

  it('should have schema defaults for every provider', () => {
    expect(probeLimitsSchema.parse({})).toEqual({
      gateway: 8,
      dataforseo: 2,
      claude_code: 2,
      codex: 1,
      cursor: 2,
      analyzer: 4,
    });
  });
});

describe('limits - ProbeLimiter.pause()', () => {
  it('should hold new work on the paused provider until the pause ends', async () => {
    const limiter = new ProbeLimiter(probeLimitsSchema.parse({}));
    const startedAtMs = Date.now();

    limiter.pause('codex', 40);

    const ranAfterMs = await limiter.run('codex', () =>
      Promise.resolve(Date.now() - startedAtMs),
    );

    expect(ranAfterMs).toBeGreaterThanOrEqual(35);
  });

  it('should NOT hold work on other providers', async () => {
    const limiter = new ProbeLimiter(probeLimitsSchema.parse({}));
    const startedAtMs = Date.now();

    limiter.pause('codex', 1_000);

    const ranAfterMs = await limiter.run('cursor', () =>
      Promise.resolve(Date.now() - startedAtMs),
    );

    expect(ranAfterMs).toBeLessThan(100);
  });

  it('should hold a caller that queued for a slot before the pause started', async () => {
    const limiter = new ProbeLimiter(probeLimitsSchema.parse({ codex: 1 }));
    const gate = deferred();
    const first = limiter.run('codex', () => gate.promise);
    const second = limiter.run('codex', () => Promise.resolve(Date.now()));

    await pause(5);
    limiter.pause('codex', 40);
    const pausedAtMs = Date.now();
    gate.resolve();
    await first;

    const secondRanAtMs = await second;

    expect(secondRanAtMs - pausedAtMs).toBeGreaterThanOrEqual(35);
  });

  it('should stop waiting when the signal aborts', async () => {
    const limiter = new ProbeLimiter(probeLimitsSchema.parse({}));
    const controller = new AbortController();
    const startedAtMs = Date.now();

    limiter.pause('codex', 10_000);
    setTimeout(() => controller.abort(), 10);

    const ranAfterMs = await limiter.run(
      'codex',
      () => Promise.resolve(Date.now() - startedAtMs),
      { signal: controller.signal },
    );

    expect(ranAfterMs).toBeLessThan(1_000);
  });
});
