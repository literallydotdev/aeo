import { z } from 'zod';

// ============================================================================
// Execution limits (hardening spec §4.5): one bounded pool per provider —
// the gateway (chat probes), DataForSEO, each agent CLI, and the analyzer
// passes — shared across every section of a run. Sizes come from the run
// request with schema defaults, never magic numbers in the pipeline. A
// worker that must wait out a capacity ladder releases its slot first, so
// a Claude 529 storm never parks the Codex and Cursor pools.
// ============================================================================

export const probeLimitsSchema = z.object({
  // Chat-surface probes through the AI gateway (each is one or two calls).
  gateway: z.number().int().min(1).default(8),
  // Live SERP tasks; DataForSEO throttles aggressively.
  dataforseo: z.number().int().min(1).default(2),
  // Full Node processes with network access, one pool per CLI.
  claude_code: z.number().int().min(1).default(2),
  // One at a time: a web-search answer is 5–16 model calls, and two in
  // parallel exhaust the plan's short-window limit (2026-10-21).
  codex: z.number().int().min(1).default(1),
  cursor: z.number().int().min(1).default(2),
  // Analyzer, perception and domain-label passes (75k-token requests).
  analyzer: z.number().int().min(1).default(4),
});

export type ProbeLimits = z.infer<typeof probeLimitsSchema>;

export type ProbeProvider = keyof ProbeLimits;

class Semaphore {
  readonly #size: number;
  readonly #waiters: Array<() => void>;
  #active: number;

  constructor(size: number) {
    this.#size = size;
    this.#waiters = [];
    this.#active = 0;
  }

  async acquire(): Promise<() => void> {
    if (this.#active < this.#size) {
      this.#active += 1;
    } else {
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
      });

      this.#active += 1;
    }

    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.#active -= 1;
      const next = this.#waiters.shift();

      if (next) {
        next();
      }
    };
  }
}

type RunOptions = {
  signal?: AbortSignal;
  /** A pause of its own the work also waits out, beside its pool's: one
   * adapter's capacity pause, so a 429 on one surface never holds back
   * another surface sharing the pool. */
  pauseKey?: string;
};

export class ProbeLimiter {
  readonly #pools: Record<ProbeProvider, Semaphore>;
  // When each paused pool or adapter may resume, by its key.
  readonly #resumeAtMs = new Map<string, number>();

  constructor(limits: ProbeLimits) {
    this.#pools = {
      gateway: new Semaphore(limits.gateway),
      dataforseo: new Semaphore(limits.dataforseo),
      claude_code: new Semaphore(limits.claude_code),
      codex: new Semaphore(limits.codex),
      cursor: new Semaphore(limits.cursor),
      analyzer: new Semaphore(limits.analyzer),
    };
  }

  /**
   * Holds new work under `key` (a provider pool, or the pause key of one
   * adapter) for `delayMs`, extending any pause already running. A
   * rate-limited provider then sees one retry per window instead of every
   * queued unit spending an attempt on the same 429.
   */
  pause(key: string, delayMs: number): void {
    const resumeAtMs = Date.now() + delayMs;

    this.#resumeAtMs.set(
      key,
      Math.max(this.#resumeAtMs.get(key) ?? 0, resumeAtMs),
    );
  }

  /** Runs `fn` once neither the provider nor the work's own pause key is
   * paused and a slot on the provider's pool is free. */
  async run<T>(
    provider: ProbeProvider,
    fn: () => Promise<T>,
    { signal, pauseKey }: RunOptions = {},
  ): Promise<T> {
    const keys = pauseKey === undefined ? [provider] : [provider, pauseKey];
    const release = await this.#acquire(provider, keys, signal);

    try {
      return await fn();
    } finally {
      release();
    }
  }

  async #acquire(
    provider: ProbeProvider,
    keys: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<() => void> {
    for (;;) {
      await this.#waitForResume(keys, signal);

      const release = await this.#pools[provider].acquire();

      // A pause may have started while this caller queued for the slot.
      if (this.#getPauseMs(keys) <= 0 || signal?.aborted) {
        return release;
      }

      release();
    }
  }

  async #waitForResume(
    keys: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    while (this.#getPauseMs(keys) > 0 && !signal?.aborted) {
      await sleep(this.#getPauseMs(keys), signal);
    }
  }

  #getPauseMs(keys: readonly string[]): number {
    const now = Date.now();

    return Math.max(
      ...keys.map((key) => (this.#resumeAtMs.get(key) ?? 0) - now),
    );
  }
}

/** An unbounded limiter for tests and one-off scripts. */
export const unlimited = (): ProbeLimiter => {
  return new ProbeLimiter({
    gateway: Number.MAX_SAFE_INTEGER,
    dataforseo: Number.MAX_SAFE_INTEGER,
    claude_code: Number.MAX_SAFE_INTEGER,
    codex: Number.MAX_SAFE_INTEGER,
    cursor: Number.MAX_SAFE_INTEGER,
    analyzer: Number.MAX_SAFE_INTEGER,
  });
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();

      return;
    }

    const done = () => {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(done, ms);

    signal?.addEventListener('abort', done, { once: true });
  });
};
