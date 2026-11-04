import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverCallback } from './callbacks';

type Respond = (response: { statusCode: number; resume: () => void }) => void;

type RequestMock = (
  url: URL,
  options: RequestOptions,
  respond: Respond,
) => EventEmitter;

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn<RequestMock>(),
}));

vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:https', () => ({ request: network.request }));

describe('Callbacks - deliverCallback()', () => {
  const url = new URL('https://callbacks.example.test/aeo');
  const primaryAddress = { address: '8.8.8.8', family: 4 };
  const address = [primaryAddress];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([true, false])(
    'should pin the validated address with lookup all=%s and preserve the TLS hostname',
    async (all) => {
      network.lookup.mockResolvedValue([
        ...address,
        { address: '1.1.1.1', family: 4 },
      ]);

      const resolved = vi.fn();

      network.request.mockImplementation((requestedUrl, options, respond) => {
        expect(requestedUrl).toBe(url);
        expect(requestedUrl.hostname).toBe('callbacks.example.test');

        options.lookup?.(requestedUrl.hostname, { all }, resolved);

        return Object.assign(new EventEmitter(), {
          end: () => respond({ statusCode: 204, resume: vi.fn() }),
        });
      });

      await deliverCallback(url, { rawBody: '{}', signature: 'signature' });

      expect(network.lookup).toHaveBeenCalledExactlyOnceWith(url.hostname, {
        all: true,
      });
      expect(resolved).toHaveBeenCalledExactlyOnceWith(
        ...(all
          ? [null, address]
          : [null, primaryAddress.address, primaryAddress.family]),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('should time out stalled DNS and NOT send when the lookup later completes', async () => {
    let resolveLookup: (value: typeof address) => void = () => {};

    network.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const result = deliverCallback(url, {
      rawBody: '{}',
      signature: 'signature',
    });

    const rejected = expect(result).rejects.toThrow(
      'Callback delivery timed out',
    );

    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    resolveLookup(address);
    await vi.advanceTimersByTimeAsync(0);

    expect(network.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should include DNS time in the HTTP deadline', async () => {
    network.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(address);
          }, 4000);
        }),
    );

    const request = Object.assign(new EventEmitter(), { end: vi.fn() });
    network.request.mockImplementation((_url, options) => {
      options.signal?.addEventListener('abort', () => {
        request.emit('error', new Error('Request aborted'));
      });

      return request;
    });

    const result = deliverCallback(url, {
      rawBody: '{}',
      signature: 'signature',
    });
    const rejected = expect(result).rejects.toThrow('Request aborted');

    await vi.advanceTimersByTimeAsync(4000);

    expect(network.request).toHaveBeenCalledOnce();
    expect(request.end).toHaveBeenCalledWith('{}');

    await vi.advanceTimersByTimeAsync(1000);
    await rejected;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('should clear the deadline after a successful response', async () => {
    network.lookup.mockResolvedValue(address);

    network.request.mockImplementation((_url, _options, respond) => {
      const request = Object.assign(new EventEmitter(), {
        end: () => respond({ statusCode: 204, resume: vi.fn() }),
      });

      return request;
    });

    await expect(
      deliverCallback(url, { rawBody: '{}', signature: 'signature' }),
    ).resolves.toBeUndefined();

    expect(vi.getTimerCount()).toBe(0);
  });
});
