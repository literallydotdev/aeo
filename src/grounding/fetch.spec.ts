import { EventEmitter } from 'node:events';
import type { LookupAddress } from 'node:dns';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireDefined } from '../__fixtures__/require-defined';
import { fetchGroundingSource, sourceLimits } from './fetch';

type LookupCallback = (...args: unknown[]) => void;

type RequestOptions = {
  headers: Record<string, string>;
  lookup: (
    host: string,
    options: { all: boolean },
    callback: LookupCallback,
  ) => void;
};

const network = vi.hoisted(() => ({
  lookup: vi.fn<(host: string) => Promise<LookupAddress[]>>(),
  request:
    vi.fn<
      (
        url: URL,
        options: RequestOptions,
        callback: (response: unknown) => void,
      ) => EventEmitter
    >(),
}));

vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:https', () => ({ request: network.request }));

const respond = (
  status: number,
  { headers, body }: { headers: Record<string, string>; body: string },
) => {
  network.request.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };

    req.end = () => {
      const response = Object.assign(Readable.from([Buffer.from(body)]), {
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

describe('fetch - fetchGroundingSource()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  it('should refuse a public hostname resolving to any private address before sending', async () => {
    network.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);

    const result = fetchGroundingSource({ url: 'https://docs.example.com/' });

    await expect(result).rejects.toMatchObject({
      reason: 'unsafe_destination',
    });
    expect(network.request).not.toHaveBeenCalled();
  });

  it('should pin both Node lookup result shapes to the validated address and send no credentials', async () => {
    respond(200, {
      headers: { 'content-type': 'text/plain' },
      body: 'A retained source passage.',
    });

    await fetchGroundingSource({ url: 'https://docs.example.com/' });

    const [, options] = requireDefined(
      network.request.mock.calls[0],
      'request call',
    );
    const scalar = vi.fn();
    const multiple = vi.fn();

    options.lookup('docs.example.com', { all: false }, scalar);
    options.lookup('docs.example.com', { all: true }, multiple);

    expect(scalar).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(multiple).toHaveBeenCalledWith(null, [
      { address: '8.8.8.8', family: 4 },
    ]);
    expect(options.headers).not.toHaveProperty('authorization');
    expect(options.headers).not.toHaveProperty('x-aeo-signature');
  });

  it('should reject a redirect to a metadata address without making its request', async () => {
    respond(302, {
      headers: { location: 'https://169.254.169.254/latest/meta-data/' },
      body: '',
    });

    const result = fetchGroundingSource({ url: 'https://docs.example.com/' });

    await expect(result).rejects.toMatchObject({
      reason: 'unsafe_destination',
    });
    expect(network.request).toHaveBeenCalledOnce();
  });

  it('should resolve and reserve every redirect request independently', async () => {
    respond(302, {
      headers: { location: 'https://new.example.com/docs' },
      body: '',
    });
    respond(200, {
      headers: { 'content-type': 'text/plain' },
      body: 'Relevant documentation.',
    });
    const beforeRequest = vi.fn(() => Promise.resolve());

    const result = await fetchGroundingSource({
      url: 'https://docs.example.com/',
      beforeRequest,
    });

    expect(network.lookup).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(result.requestCount).toBe(2);
    expect(result.source.finalUrl).toBe('https://new.example.com/docs');
  });

  it('should bound response bytes and report HTTP status without retaining error documents', async () => {
    respond(200, {
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(sourceLimits.receivedBytes + 1),
    });

    const oversized = fetchGroundingSource({
      url: 'https://docs.example.com/',
    });

    await expect(oversized).rejects.toMatchObject({ reason: 'too_large' });

    respond(403, {
      headers: { 'content-type': 'text/plain' },
      body: 'Private error body',
    });

    const forbidden = fetchGroundingSource({
      url: 'https://docs.example.com/',
    });

    await expect(forbidden).rejects.toMatchObject({
      reason: 'http_error',
      status: 403,
    });
  });

  it('should read a large hydrated page while retaining only bounded article text', async () => {
    const text = 'Documented product capability. '.repeat(1000);

    respond(200, {
      headers: { 'content-type': 'text/html' },
      body: `<html><head><script>${'x'.repeat(
        1_400_000,
      )}</script></head><body><main>${text}</main></body></html>`,
    });

    const result = await fetchGroundingSource({
      url: 'https://docs.example.com/',
    });

    const passage = requireDefined(result.source.passages[0], 'passage');

    expect(passage.text).toContain('Documented product capability.');
    expect(passage.text).not.toContain('xxx');
    expect(Buffer.byteLength(passage.text)).toBeLessThanOrEqual(16_384);
    expect(result.source.truncated).toBe(true);
  });

  it('should abort a stalled DNS lookup without sending after it completes', async () => {
    let complete: (addresses: LookupAddress[]) => void = () => {
      return undefined;
    };

    network.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const abort = new AbortController();

    const work = fetchGroundingSource({
      url: 'https://docs.example.com/',
      signal: abort.signal,
    });
    await Promise.resolve();
    abort.abort(new Error('cancelled'));

    await expect(work).rejects.toThrow('cancelled');

    complete([{ address: '8.8.8.8', family: 4 }]);
    await Promise.resolve();

    expect(network.request).not.toHaveBeenCalled();
  });
});
