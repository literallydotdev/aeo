import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Importing an adapter does nothing (probe adapters spec §8, "Purity"): no
// environment read, no connection, no timer. Everything an adapter needs is
// passed in when it is created. Reads made by the test runner or a library
// while loading are not the adapter's; only reads from the engine's own
// probe modules count.
// ============================================================================

const adapterModules = [
  '../adapter',
  '../legacy-bindings',
  '../bindings',
  './gateway-chat',
  './gateway-perplexity',
  './dataforseo-ai-overview',
  './cli-process',
  './cli-claude-code',
  './cli-codex',
  './cli-cursor',
  './cli-agents',
] as const;

const ownFrame = /[\\/]src[\\/]probes[\\/]/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probe adapters - import', () => {
  it.each(adapterModules)(
    'should read no environment, open no connection and start no timer when %s is imported',
    async (modulePath) => {
      vi.resetModules();
      const reads: string[] = [];
      const environment = process.env;
      const recorder = new Proxy(environment, {
        get: (target, key, receiver) => {
          const stack = new Error().stack ?? '';

          if (
            typeof key === 'string' &&
            stack
              .split('\n')
              .slice(2)
              .some((frame) => ownFrame.test(frame))
          ) {
            reads.push(key);
          }

          const value: unknown = Reflect.get(target, key, receiver);

          return value;
        },
      });
      // A timer started by an engine probe module, with the stack it was
      // started from.
      const ownTimers: string[] = [];
      const recordTimer = (name: string) => () => {
        const stack = new Error().stack ?? '';

        if (
          stack
            .split('\n')
            .slice(2)
            .some((frame) => ownFrame.test(frame))
        ) {
          ownTimers.push(name);
        }
      };
      const originalSetTimeout = globalThis.setTimeout;
      const originalSetInterval = globalThis.setInterval;

      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (...args: Parameters<typeof setTimeout>) => {
          recordTimer('setTimeout')();

          return originalSetTimeout(...args);
        },
      );
      vi.spyOn(globalThis, 'setInterval').mockImplementation(
        (...args: Parameters<typeof setInterval>) => {
          recordTimer('setInterval')();

          return originalSetInterval(...args);
        },
      );
      const connections = vi.spyOn(net, 'connect');
      const fetches = vi.fn();

      vi.stubGlobal('fetch', fetches);
      process.env = recorder;

      try {
        await import(/* @vite-ignore */ modulePath);
      } finally {
        process.env = environment;
      }

      expect(reads).toEqual([]);
      expect(fetches).not.toHaveBeenCalled();
      expect(connections).not.toHaveBeenCalled();
      expect(ownTimers).toEqual([]);
    },
  );
});
