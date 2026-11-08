import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractGroundingRedirectUrls,
  isGroundingRedirectUrl,
  resolveGroundingRedirects,
  rewriteTextUrls,
  traceGroundingRedirects,
} from './grounding-urls';

// Ported from the console's grounding-urls.test.ts (behavioral parity), plus
// the Google AI Overview goto wrappers (added 2026-08-28).

const redirectA =
  'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZaaa';

const redirectB =
  'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZbbb';

// A strict string-prefix of redirectLong — the collision case.
const redirectShort =
  'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZabc';

const redirectLong = `${redirectShort}def`;
// Google AI Overview reference wrappers: bare host 301s to www, www 302s
// to the real page.
const gotoBare = 'https://google.com/goto?url=CAESUAHrOzAVf6YZ_-x';
const gotoWww = 'https://www.google.com/goto?url=CAESUAHrOzAVf6YZ_-x';

const redirectResponse = (location: string, status = 302) => {
  return new Response(null, { status, headers: { location } });
};

describe('grounding-urls - isGroundingRedirectUrl()', () => {
  it('should recognise Gemini grounding and both Google goto hosts', () => {
    expect(isGroundingRedirectUrl(redirectA)).toBe(true);
    expect(isGroundingRedirectUrl(gotoBare)).toBe(true);
    expect(isGroundingRedirectUrl(gotoWww)).toBe(true);
    expect(isGroundingRedirectUrl('https://www.google.com/search?q=x')).toBe(
      false,
    );

    expect(isGroundingRedirectUrl('https://acme.example/')).toBe(false);
  });
});

describe('grounding-urls - extractGroundingRedirectUrls()', () => {
  it('should find redirect URLs and strip trailing punctuation', () => {
    const text = `Sources:\n- ${redirectA}.\n- (${redirectB})\nSee https://www.reddit.com/r/rails too.`;
    expect(extractGroundingRedirectUrls(text)).toEqual([redirectA, redirectB]);
  });

  it('should find Google goto wrappers in AI Overview source lists', () => {
    const text = `Sources cited in AI Overview:\n- Acme: "Unlimited LLM API" — ${gotoBare}\n- Docs: "x" — https://docs.example.com/page`;
    expect(extractGroundingRedirectUrls(text)).toEqual([gotoBare]);
  });

  it('should return nothing for text without a wrapper prefix', () => {
    expect(
      extractGroundingRedirectUrls('Plain answer citing https://sentry.io'),
    ).toEqual([]);
  });
});

describe('grounding-urls - traceGroundingRedirects()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should report each wrapper target or why it has none, with its hops, in the order found', async () => {
    const responses: Record<string, () => Promise<Response>> = {
      [gotoBare]: () => Promise.resolve(redirectResponse(gotoWww, 301)),
      [gotoWww]: () =>
        Promise.resolve(redirectResponse('https://rival.example/blog')),
      [redirectA]: () => Promise.resolve(new Response(null, { status: 404 })),
      [redirectB]: () => Promise.reject(new Error('network down')),
    };

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const respond = responses[url];

        if (!respond) {
          throw new Error(`Unexpected request: ${url}.`);
        }

        return respond();
      }),
    );

    const { resolved, resolutions } = await traceGroundingRedirects([
      gotoBare,
      redirectA,
      redirectB,
    ]);

    expect(resolutions).toEqual([
      { url: gotoBare, target: 'https://rival.example/blog', hops: 2 },
      {
        url: redirectA,
        target: null,
        hops: 1,
        failure: 'HTTP 404 without a redirect',
      },
      { url: redirectB, target: null, hops: 0, failure: 'network down' },
    ]);
    expect([...resolved]).toEqual([[gotoBare, 'https://rival.example/blog']]);
  });
});

describe('grounding-urls - resolveGroundingRedirects()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should resolve redirects via their Location header, deduped', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(redirectResponse('https://scoutapm.com/blog/post'));

    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveGroundingRedirects([
      redirectA,
      redirectA,
      'https://www.reddit.com/r/rails',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolved.get(redirectA)).toBe('https://scoutapm.com/blog/post');
  });

  it('should omit redirects that fail, respond non-3xx, or point off-http', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
        .mockResolvedValueOnce(redirectResponse('javascript:alert(1)')),
    );

    const resolved = await resolveGroundingRedirects([redirectA, redirectB]);
    expect(resolved.size).toBe(0);
  });

  it('should never fetch when there is nothing to resolve', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveGroundingRedirects([
      'https://docs.appsignal.com/ruby',
    ]);

    expect(resolved.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should follow a goto wrapper through the www hop to the real page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(gotoWww, 301))
      .mockResolvedValueOnce(
        redirectResponse('https://acme.example/unlimited-llm-api'),
      );

    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveGroundingRedirects([gotoBare]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(gotoWww);
    expect(resolved.get(gotoBare)).toBe(
      'https://acme.example/unlimited-llm-api',
    );
  });

  it('should give up on a chain that never leaves the wrapper allow-list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirectResponse(gotoWww, 301));

    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveGroundingRedirects([gotoBare]);

    expect(resolved.size).toBe(0);
    // Bounded: never loops on a self-redirecting wrapper.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should keep going when one resolution throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(redirectResponse('https://newrelic.com/docs')),
    );

    const resolved = await resolveGroundingRedirects([redirectA, redirectB]);
    expect(resolved.size).toBe(1);
    expect(resolved.get(redirectB)).toBe('https://newrelic.com/docs');
  });
});

describe('grounding-urls - rewriteTextUrls()', () => {
  it('should replace every occurrence, preserving trailing punctuation', () => {
    const resolved = new Map([[redirectA, 'https://scoutapm.com/post']]);
    const text = `Sources:\n- ${redirectA}.\n- ${redirectA}`;
    expect(rewriteTextUrls(text, resolved)).toBe(
      'Sources:\n- https://scoutapm.com/post.\n- https://scoutapm.com/post',
    );
  });

  it('should leave unresolved redirects untouched', () => {
    const resolved = new Map([[redirectA, 'https://scoutapm.com/post']]);
    expect(rewriteTextUrls(redirectB, resolved)).toBe(redirectB);
  });

  it('should never corrupt a redirect whose token extends another resolved token', () => {
    // Insertion order puts the shorter (prefix) key first — the naive
    // split/join approach would garble redirectLong. Maximal-run matching
    // must keep each URL intact.
    const resolved = new Map([
      [redirectShort, 'https://short.example.com/'],
      [redirectLong, 'https://long.example.com/'],
    ]);

    const text = `A: ${redirectLong} B: ${redirectShort}`;
    expect(rewriteTextUrls(text, resolved)).toBe(
      'A: https://long.example.com/ B: https://short.example.com/',
    );
  });

  it('should be a no-op when the map is empty', () => {
    expect(rewriteTextUrls(`x ${redirectA}`, new Map())).toBe(`x ${redirectA}`);
  });
});
