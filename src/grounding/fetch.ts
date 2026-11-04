import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { load } from 'cheerio';
import { contentHash } from '../stores/content-hash';
import { isPublicAddress } from '../workflow/callbacks';
import { sourceExtractionVersion, type GroundingSource } from './schema';

export const sourceLimits = {
  timeoutMs: 15_000,
  receivedBytes: 2_097_152,
  retainedBytes: 16_384,
  redirects: 3,
} as const;

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

/**
 * canonicalResearchUrl returns a URL as research receipts compare it: no
 * hash, lowercase host, no trailing slash on a path. The author's journal, its
 * saved pages and the validator's source rule all use this one form.
 */
export const canonicalResearchUrl = (value: string): string => {
  const url = new URL(value);

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
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

const requestDocument = async (
  url: URL,
  signal: AbortSignal,
): Promise<{
  status: number;
  location?: string;
  contentType: string;
  body: string;
}> => {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await withAbort(lookup(host, { all: true }), signal);

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

  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        signal,
        headers: {
          'accept': 'text/html,text/plain',
          'accept-encoding': 'identity',
          'user-agent': 'Literally-AEO-Research/1',
        },
        lookup: (_host, options, callback) => {
          if (options.all) {
            callback(null, [firstAddress]);
          } else {
            callback(null, firstAddress.address, firstAddress.family);
          }
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = response.headers['content-type'] ?? '';

        if (status >= 300 && status < 400) {
          response.destroy();
          resolve({
            status,
            location: response.headers.location,
            contentType,
            body: '',
          });

          return;
        }

        if (status < 200 || status >= 300) {
          response.destroy();
          reject(
            new SourceRetrievalError('http_error', `Source HTTP ${status}.`, {
              status,
            }),
          );

          return;
        }

        if (
          !/^(text\/html|text\/plain|application\/xhtml\+xml)(;|$)/i.test(
            contentType,
          ) ||
          (response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity')
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

          if (bytes > sourceLimits.receivedBytes) {
            response.destroy();
            reject(
              new SourceRetrievalError(
                'too_large',
                `Source response exceeds byte limit: ${bytes} bytes.`,
              ),
            );

            return;
          }

          chunks.push(chunk);
        });

        response.once('error', reject);
        response.once('end', () => {
          resolve({
            status,
            contentType,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.once('error', reject);
    req.end();
  });
};

/**
 * boundedUtf8 returns the longest prefix of the text within the byte budget,
 * never ending inside a multibyte character.
 */
export const boundedUtf8 = (text: string, bytes: number): string => {
  return Buffer.from(text)
    .subarray(0, bytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
};

export const extractSourceDocument = (args: {
  requestedUrl: string;
  finalUrl: string;
  body: string;
  contentType: string;
  fetchedAt: string;
  firstPartyHosts?: readonly string[];
}): { source: GroundingSource; links: string[]; text: string } => {
  const final = validateResearchUrl(args.finalUrl);

  validateResearchUrl(args.requestedUrl);

  if (Buffer.byteLength(args.body) > sourceLimits.receivedBytes) {
    throw new SourceRetrievalError(
      'too_large',
      `Source response exceeds byte limit: ${Buffer.byteLength(args.body)} bytes.`,
    );
  }

  let text: string;
  let title = '';
  let sourceDate: string | null = null;
  const links: string[] = [];

  if (/html/i.test(args.contentType)) {
    const $ = load(args.body);

    title = $('title').first().text().trim().slice(0, 500);

    const declaredDate =
      $('meta[property="article:published_time"]').attr('content') ??
      $('meta[name="date"]').attr('content');
    if (
      declaredDate &&
      /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(declaredDate) &&
      Number.isFinite(Date.parse(declaredDate))
    ) {
      sourceDate = new Date(declaredDate).toISOString();
    }

    $(
      'script,style,noscript,iframe,object,embed,svg,form,input,button,nav,footer,header',
    ).remove();
    $('a[href]').each((_index, element) => {
      const href = $(element).attr('href');

      if (links.length >= 100 || href === undefined) {
        return;
      }

      try {
        const url = validateResearchUrl(new URL(href, final).href).href;

        if (!links.includes(url)) {
          links.push(url);
        }
      } catch {
        // Unsafe links remain ineligible for discovery.
      }
    });

    $('p,div,li,h1,h2,h3,h4,section,article,br,tr').append('\n');
    text = ($('main').length ? $('main').text() : $('body').text())
      .replace(/[\t\r ]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();
  } else {
    text = args.body.replace(/\r\n/g, '\n').trim();
  }

  if (!text) {
    throw new SourceRetrievalError(
      'empty_content',
      `No readable source text: ${final.href}.`,
    );
  }

  const documentDigest = contentHash(text);
  const retained = boundedUtf8(text, sourceLimits.retainedBytes);
  const id = `src_${contentHash({ url: final.href, documentDigest }).slice(0, 32)}`;
  // Contiguous text preserves qualifications and surrounding context; the model cannot choose its own quote.
  const passages = [
    { id: `${id}_p0`, text: retained, digest: contentHash(retained) },
  ];

  return {
    source: {
      id,
      requestedUrl: args.requestedUrl,
      finalUrl: final.href,
      title,
      publisher: final.hostname,
      provenance: args.firstPartyHosts?.includes(final.hostname)
        ? 'first_party'
        : 'unknown',
      fetchedAt: args.fetchedAt,
      sourceDate,
      documentDigest,
      retainedDigest: contentHash(passages.map((passage) => passage.text)),
      passages,
      extractionVersion: sourceExtractionVersion,
      truncated: retained !== text,
    },
    links,
    // The whole extracted text, for a reader that keeps more than the
    // grounding passage (the author's research tools keep 32 KB).
    text,
  };
};

export const fetchGroundingSource = async (args: {
  url: string;
  signal?: AbortSignal;
  firstPartyHosts?: readonly string[];
  beforeRequest?: () => Promise<void>;
}): Promise<{
  source: GroundingSource;
  links: string[];
  text: string;
  requestCount: number;
  /** Body bytes received for the final document. */
  bytes: number;
}> => {
  const signal = AbortSignal.any([
    AbortSignal.timeout(sourceLimits.timeoutMs),
    ...(args.signal ? [args.signal] : []),
  ]);
  let url = validateResearchUrl(args.url);

  try {
    for (
      let redirects = 0;
      redirects <= sourceLimits.redirects;
      redirects += 1
    ) {
      await args.beforeRequest?.();
      signal.throwIfAborted();

      const response = await requestDocument(url, signal);

      if (response.status >= 300 && response.status < 400) {
        if (!response.location || redirects === sourceLimits.redirects) {
          throw new SourceRetrievalError(
            'http_error',
            `Source redirect limit exceeded: ${url.href}.`,
          );
        }

        url = validateResearchUrl(new URL(response.location, url).href);

        continue;
      }

      return {
        ...extractSourceDocument({
          requestedUrl: args.url,
          finalUrl: url.href,
          body: response.body,
          contentType: response.contentType,
          fetchedAt: new Date().toISOString(),
          firstPartyHosts: args.firstPartyHosts,
        }),
        requestCount: redirects + 1,
        bytes: Buffer.byteLength(response.body),
      };
    }

    throw new SourceRetrievalError(
      'http_error',
      `Source redirect limit exceeded: ${url.href}.`,
    );
  } catch (error) {
    if (args.signal?.aborted) {
      throw args.signal.reason;
    }

    if (error instanceof SourceRetrievalError) {
      throw error;
    }

    throw new SourceRetrievalError(
      signal.aborted ? 'timeout' : 'network_error',
      `Source retrieval failed: ${url.href}.`,
      { cause: error },
    );
  }
};
