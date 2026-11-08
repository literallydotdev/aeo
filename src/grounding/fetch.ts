import { load } from 'cheerio';
import { contentHash } from '../stores/content-hash';
import {
  guardedRequest,
  SourceRetrievalError,
  validateResearchUrl,
} from './guarded-request';
import { sourceExtractionVersion, type GroundingSource } from './schema';

export const sourceLimits = {
  timeoutMs: 15_000,
  receivedBytes: 2_097_152,
  retainedBytes: 16_384,
  redirects: 3,
} as const;

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
  const response = await guardedRequest({
    url: args.url,
    timeoutInMs: sourceLimits.timeoutMs,
    signal: args.signal,
    userAgent: 'Literally-AEO-Research/1',
    accept: 'text/html,text/plain',
    redirects: sourceLimits.redirects,
    body: {
      contentTypes: /^(text\/html|text\/plain|application\/xhtml\+xml)(;|$)/i,
      maxBytes: sourceLimits.receivedBytes,
      oversize: 'refuse',
    },
    pace: async (_url, send) => {
      await args.beforeRequest?.();

      return send();
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new SourceRetrievalError(
      'http_error',
      `Source HTTP ${response.status}.`,
      { status: response.status },
    );
  }

  const body = response.body?.toString('utf8') ?? '';
  const document = extractSourceDocument({
    requestedUrl: args.url,
    finalUrl: response.url,
    body,
    contentType: response.contentType,
    fetchedAt: new Date().toISOString(),
    firstPartyHosts: args.firstPartyHosts,
  });

  return {
    ...document,
    requestCount: response.hops.length,
    bytes: Buffer.byteLength(body),
  };
};
