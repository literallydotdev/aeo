import type { LookupAddress } from 'node:dns';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHostPacer,
  guardedRequest,
  type GuardedRequestOptions,
} from './guarded-request';

// ============================================================================
// The guard every site request passes, against a fake resolver and a fake
// https transport: what it refuses at each hop, what it returns, how it
// bounds a body, and how the pacer spaces requests per host.
// ============================================================================

const network = vi.hoisted(() => ({
  lookup: vi.fn<(host: string) => Promise<LookupAddress[]>>(),
  request:
    vi.fn<
      (
        url: URL,
        options: { headers: Record<string, string> },
        callback: (response: unknown) => void,
      ) => EventEmitter
    >(),
}));

vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:https', () => ({ request: network.request }));

const respond = (
  status: number,
  {
    headers = {},
    chunks = [],
  }: { headers?: Record<string, string>; chunks?: Buffer[] } = {},
) => {
  network.request.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };

    req.end = () => {
      const response = Object.assign(Readable.from(chunks), {
        statusCode: status,
        headers,
      });

      queueMicrotask(() => {
        callback(response);
      });
    };

    return req;
  });
};

const robotsOptions = (
  overrides: Partial<GuardedRequestOptions> = {},
): GuardedRequestOptions => {
  return {
    url: 'https://acme.example/robots.txt',
    timeoutInMs: 5_000,
    userAgent: 'literally-aeo-audit/1.0',
    accept: '*/*',
    redirects: 5,
    body: { contentTypes: 'any', maxBytes: 500 * 1024, oversize: 'truncate' },
    ...overrides,
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});

describe('guarded-request - guardedRequest()', () => {
  it('should return a 404 or a 503 as a status, without reading the body', async () => {
    respond(404, { chunks: [Buffer.from('not here')] });
    respond(503, { chunks: [Buffer.from('down')] });

    const missing = await guardedRequest(robotsOptions());
    const down = await guardedRequest(robotsOptions());

    expect(missing).toMatchObject({ status: 404, body: undefined });
    expect(down).toMatchObject({ status: 503, body: undefined });
  });

  it('should follow a redirect, validate every hop and record each one', async () => {
    respond(301, { headers: { location: 'https://www.acme.example/robots' } });
    respond(200, {
      headers: { 'content-type': 'text/plain' },
      chunks: [Buffer.from('User-agent: *\nDisallow:\n')],
    });

    const response = await guardedRequest(robotsOptions());

    expect(response.url).toBe('https://www.acme.example/robots');
    expect(response.hops).toEqual([
      { url: 'https://acme.example/robots.txt', status: 301 },
      { url: 'https://www.acme.example/robots', status: 200 },
    ]);
    expect(network.lookup).toHaveBeenCalledWith('www.acme.example', {
      all: true,
    });
  });

  it('should refuse a redirect to a private address, to http, or to a name resolving privately, before sending it', async () => {
    respond(302, { headers: { location: 'https://169.254.169.254/latest' } });
    await expect(guardedRequest(robotsOptions())).rejects.toMatchObject({
      reason: 'unsafe_destination',
    });

    respond(302, { headers: { location: 'http://acme.example/robots.txt' } });
    await expect(guardedRequest(robotsOptions())).rejects.toMatchObject({
      reason: 'unsafe_destination',
    });

    respond(302, { headers: { location: 'https://internal.acme.example/' } });
    network.lookup
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(guardedRequest(robotsOptions())).rejects.toMatchObject({
      reason: 'unsafe_destination',
    });

    // Three first hops sent, no second hop.
    expect(network.request).toHaveBeenCalledTimes(3);
  });

  it('should refuse past the call’s redirect limit', async () => {
    respond(302, { headers: { location: '/a' } });
    respond(302, { headers: { location: '/b' } });

    await expect(
      guardedRequest(robotsOptions({ redirects: 1 })),
    ).rejects.toMatchObject({ reason: 'http_error' });
    expect(network.request).toHaveBeenCalledTimes(2);
  });

  it('should truncate an oversized body at the limit and say so', async () => {
    respond(200, {
      chunks: [Buffer.alloc(300 * 1024, 'a'), Buffer.alloc(300 * 1024, 'b')],
    });

    const response = await guardedRequest(robotsOptions());

    expect(response.isTruncated).toBe(true);
    expect(response.body?.length).toBe(500 * 1024);
    expect(response.body?.at(-1)).toBe('b'.charCodeAt(0));
  });

  it('should refuse an oversized body when the call says so', async () => {
    respond(200, { chunks: [Buffer.alloc(2048)] });

    await expect(
      guardedRequest(
        robotsOptions({
          body: { contentTypes: 'any', maxBytes: 1024, oversize: 'refuse' },
        }),
      ),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('should refuse an encoded body and a content type the call does not allow', async () => {
    respond(200, {
      headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
      chunks: [Buffer.from('x')],
    });
    respond(200, {
      headers: { 'content-type': 'application/pdf' },
      chunks: [Buffer.from('x')],
    });
    const html = robotsOptions({
      body: { contentTypes: /^text\/html/, maxBytes: 1024, oversize: 'refuse' },
    });

    await expect(guardedRequest(robotsOptions())).rejects.toMatchObject({
      reason: 'unsupported_content',
    });
    await expect(guardedRequest(html)).rejects.toMatchObject({
      reason: 'unsupported_content',
    });
  });

  it('should time a hop from when it is sent, NOT from when it queued behind the host’s earlier requests', async () => {
    respond(200, { chunks: [Buffer.from('ok')] });

    // The host's turn comes after the timeout would have run out: a render
    // or a slow page ahead of it in the pacer.
    const response = await guardedRequest(
      robotsOptions({
        timeoutInMs: 50,
        pace: async (_url, send) => {
          await delay(150);

          return send();
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  it('should send the call’s agent and Accept header, and never ask for compression', async () => {
    respond(200, { chunks: [Buffer.from('ok')] });

    await guardedRequest(robotsOptions({ userAgent: 'Bot/1', accept: 'x/y' }));

    expect(network.request.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        'accept': 'x/y',
        'accept-encoding': 'identity',
        'user-agent': 'Bot/1',
      },
    });
  });
});

describe('guarded-request - createHostPacer()', () => {
  it('should send one request at a time per host, an interval apart, and hosts side by side', async () => {
    const events: string[] = [];
    const waits: number[] = [];
    const pace = createHostPacer(1000, (ms) => {
      waits.push(ms);

      return Promise.resolve();
    });
    const send = (label: string) => async () => {
      events.push(`start ${label}`);
      await Promise.resolve();
      events.push(`end ${label}`);

      return label;
    };

    const results = await Promise.all([
      pace(new URL('https://acme.example/a'), send('a1')),
      pace(new URL('https://acme.example/b'), send('a2')),
      pace(new URL('https://rival.example/'), send('r1')),
    ]);

    expect(results).toEqual(['a1', 'a2', 'r1']);
    expect(events.indexOf('start a2')).toBeGreaterThan(
      events.indexOf('end a1'),
    );
    expect(events.indexOf('start r1')).toBeLessThan(events.indexOf('end a1'));
    expect(waits).toEqual([1000]);
  });

  it('should keep pacing a host after one of its requests failed', async () => {
    const pace = createHostPacer(1000, () => Promise.resolve());
    const url = new URL('https://acme.example/');

    const failed = pace(url, () => Promise.reject(new Error('reset')));
    const next = pace(url, () => Promise.resolve('served'));

    await expect(failed).rejects.toThrow('reset');
    await expect(next).resolves.toBe('served');
  });
});
