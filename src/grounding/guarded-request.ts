import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { isPublicAddress } from '../workflow/callbacks';

// ============================================================================
// The one guard every request to a site passes through
// (specs/aeo-checks-and-reach-spec.md §3.1): https on port 443 with no
// credentials, every DNS answer public and the socket pinned to the checked
// address, each redirect hop validated again, an identity-encoded body bounded
// in bytes. The research fetch, the site checks and the Chromium proxy all
// decide destinations here.
// ============================================================================

export type SourceRetrievalReason =
  | 'unsafe_destination'
  | 'timeout'
  | 'too_large'
  | 'unsupported_content'
  | 'http_error'
  | 'empty_content'
  | 'network_error';

export class SourceRetrievalError extends Error {
  readonly reason: SourceRetrievalReason;
  readonly status: number | undefined;

  constructor(
    reason: SourceRetrievalReason,
    message: string,
    { status, cause }: { status?: number; cause?: unknown } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SourceRetrievalError';
    this.reason = reason;
    this.status = status;
  }
}

export const validateResearchUrl = (value: string): URL => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new SourceRetrievalError(
      'unsafe_destination',
      `Invalid source URL: ${value}.`,
    );
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.local') ||
    url.hostname.endsWith('.internal') ||
    url.hostname === 'metadata.google.internal'
  ) {
    throw new SourceRetrievalError(
      'unsafe_destination',
      `Source must use public HTTPS with no credentials: ${url.hostname}.`,
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host) && !isPublicAddress(host)) {
    throw new SourceRetrievalError(
      'unsafe_destination',
      `Private source destination: ${host}.`,
    );
  }

  url.hash = '';

  return url;
};

const withAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const aborted = () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- AbortSignal.reason is typed any; rejecting with it keeps the caller's abort error.
      reject(signal.reason);
    };

    signal.addEventListener('abort', aborted, { once: true });

    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', aborted);
    });
  });
};

export type LookupAll = (host: string) => Promise<LookupAddress[]>;

const lookupAll: LookupAll = (host) => {
  return lookup(host, { all: true });
};

/**
 * resolvePublicAddress returns the address a connection to the host is
 * pinned to. Every DNS answer must be public, not only the first: a host
 * that also answers with a private address could hand it to the next
 * lookup, so the socket never looks the name up again.
 */
export const resolvePublicAddress = async (
  hostname: string,
  signal: AbortSignal,
  lookupHost: LookupAll = lookupAll,
): Promise<LookupAddress> => {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = await withAbort(lookupHost(host), signal);

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new SourceRetrievalError(
      'unsafe_destination',
      `Source DNS must resolve exclusively to public addresses: ${host}.`,
    );
  }

  const [firstAddress] = addresses;

  if (!firstAddress) {
    throw new SourceRetrievalError(
      'unsafe_destination',
      `Source DNS returned no address: ${host}.`,
    );
  }

  return firstAddress;
};

/**
 * HostPacer runs one request at a time per host, each starting a fixed
 * interval after the previous one ended. One pacer serves every request of
 * a phase, so checks that run side by side still reach a site one by one.
 */
export type HostPacer = <T>(url: URL, send: () => Promise<T>) => Promise<T>;

export const createHostPacer = (
  intervalInMs: number,
  wait: (ms: number) => Promise<unknown> = delay,
): HostPacer => {
  const lastRequestByHost = new Map<string, Promise<unknown>>();

  return (url, send) => {
    const previous = lastRequestByHost.get(url.hostname);
    const current = (async () => {
      if (previous) {
        await previous;
        await wait(intervalInMs);
      }

      return send();
    })();

    lastRequestByHost.set(
      url.hostname,
      current.catch(() => undefined),
    );

    return current;
  };
};

/** How a successful response's body is read. */
export type BodyPolicy = {
  /** Content types the body may have; any other is refused unread. */
  contentTypes: RegExp | 'any';
  maxBytes: number;
  /** Past maxBytes: keep the prefix and say so, or refuse the response. */
  oversize: 'truncate' | 'refuse';
};

export type GuardedRequestOptions = {
  url: string;
  /** Bounds each hop from when it is sent; a wait for the host's turn in
   * the pacer is not counted, or a request queued behind a slow render
   * would time out without ever being sent. */
  timeoutInMs: number;
  signal?: AbortSignal;
  userAgent: string;
  accept: string;
  /** Redirects followed before the request is refused. */
  redirects: number;
  /** Absent: only the status and headers are read, never the body. */
  body?: BodyPolicy;
  /** Wraps every hop's request: the caller's spacing per host. */
  pace?: HostPacer;
};

export type GuardedHop = { url: string; status: number };

export type GuardedResponse = {
  /** The URL of the final hop. */
  url: string;
  status: number;
  contentType: string;
  /** Read only for a 2xx under a body policy. */
  body: Buffer | undefined;
  isTruncated: boolean;
  /** Every response received, the final one last. */
  hops: GuardedHop[];
};

/** A failure as a site check records it: a refused destination or redirect
 * names its reason (`unsafe_destination: …`). */
export const describeSiteError = (error: unknown): string => {
  if (error instanceof SourceRetrievalError) {
    return `${error.reason}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
};

/** A request bound to a phase's pacer: what the site checks receive. */
export type SiteRequest = (
  options: Omit<GuardedRequestOptions, 'pace'>,
) => Promise<GuardedResponse>;

type HopResponse = Omit<GuardedResponse, 'url' | 'hops'> & {
  location: string | undefined;
};

const isRedirect = (status: number): boolean => {
  return status >= 300 && status < 400;
};

const isSuccess = (status: number): boolean => {
  return status >= 200 && status < 300;
};

const requestHop = async (
  url: URL,
  options: GuardedRequestOptions,
  signal: AbortSignal,
): Promise<HopResponse> => {
  const address = await resolvePublicAddress(url.hostname, signal);

  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        signal,
        headers: {
          'accept': options.accept,
          // Never a compressed body: nothing to decompress, so no bomb to
          // bound. An encoded body despite this is refused below.
          'accept-encoding': 'identity',
          'user-agent': options.userAgent,
        },
        lookup: (_host, lookupOptions, callback) => {
          if (lookupOptions.all) {
            callback(null, [address]);
          } else {
            callback(null, address.address, address.family);
          }
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = response.headers['content-type'] ?? '';
        const encoding = response.headers['content-encoding'];
        const policy = options.body;
        const settle = (body: Buffer | undefined, isTruncated: boolean) => {
          resolve({
            status,
            location: response.headers.location,
            contentType,
            body,
            isTruncated,
          });
        };

        if (!policy || !isSuccess(status)) {
          response.destroy();
          settle(undefined, false);

          return;
        }

        if (
          (policy.contentTypes !== 'any' &&
            !policy.contentTypes.test(contentType)) ||
          (encoding && encoding !== 'identity')
        ) {
          response.destroy();
          reject(
            new SourceRetrievalError(
              'unsupported_content',
              `Unsupported source content: ${contentType}.`,
            ),
          );

          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;

        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;

          if (bytes <= policy.maxBytes) {
            chunks.push(chunk);

            return;
          }

          response.destroy();

          if (policy.oversize === 'refuse') {
            reject(
              new SourceRetrievalError(
                'too_large',
                `Source response exceeds byte limit: ${bytes} bytes.`,
              ),
            );

            return;
          }

          const kept = Buffer.concat(chunks);

          settle(
            Buffer.concat([
              kept,
              chunk.subarray(0, policy.maxBytes - kept.length),
            ]),
            true,
          );
        });

        response.once('error', reject);
        response.once('end', () => {
          settle(Buffer.concat(chunks), false);
        });
      },
    );

    req.once('error', reject);
    req.end();
  });
};

/**
 * guardedRequest sends a GET under the guard and returns any status: the
 * caller decides what a 403 or a 5xx means. A redirect it cannot follow
 * (no Location, or past the limit) and an unsafe hop are refused.
 */
export const guardedRequest = async (
  options: GuardedRequestOptions,
): Promise<GuardedResponse> => {
  const pace: HostPacer = options.pace ?? ((_url, send) => send());
  const hops: GuardedHop[] = [];
  let url = validateResearchUrl(options.url);
  let hopSignal: AbortSignal | undefined;

  try {
    for (let redirects = 0; ; redirects += 1) {
      const target = url;
      const response = await pace(target, () => {
        options.signal?.throwIfAborted();

        const signal = AbortSignal.any([
          AbortSignal.timeout(options.timeoutInMs),
          ...(options.signal ? [options.signal] : []),
        ]);

        hopSignal = signal;

        return requestHop(target, options, signal);
      });

      hops.push({ url: target.href, status: response.status });

      if (!isRedirect(response.status)) {
        const { location: _location, ...final } = response;

        return { ...final, url: target.href, hops };
      }

      if (!response.location) {
        throw new SourceRetrievalError(
          'http_error',
          `Source redirect without a location: ${target.href}.`,
        );
      }

      if (redirects === options.redirects) {
        throw new SourceRetrievalError(
          'http_error',
          `Source redirect limit exceeded: ${target.href}.`,
        );
      }

      url = validateResearchUrl(new URL(response.location, target).href);
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }

    if (error instanceof SourceRetrievalError) {
      throw error;
    }

    throw new SourceRetrievalError(
      hopSignal?.aborted ? 'timeout' : 'network_error',
      `Source retrieval failed: ${url.href}.`,
      { cause: error },
    );
  }
};
