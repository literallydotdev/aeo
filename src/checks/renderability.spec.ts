import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SourceRetrievalError,
  type HostPacer,
  type SiteRequest,
} from '../grounding/guarded-request';

// ============================================================================
// The renderability check against a fake browser and a fake site: a page
// that never goes network-idle still yields its text once loaded, instead of
// "could not check"; a refused static fetch records its reason.
// ============================================================================

const browser = vi.hoisted(() => ({
  settles: true,
  goto: vi.fn(),
  waitForLoadState: vi.fn(),
}));

const mockPage = {
  goto: (url: string, options: { waitUntil: string }) => {
    browser.goto(url, options);

    if (options.waitUntil === 'networkidle' && !browser.settles) {
      return Promise.reject(new Error('page.goto: Timeout 45000ms exceeded.'));
    }

    return Promise.resolve();
  },
  waitForLoadState: (state: string) => {
    browser.waitForLoadState(state);

    if (state === 'networkidle' && !browser.settles) {
      return Promise.reject(
        new Error('page.waitForLoadState: Timeout 8000ms exceeded.'),
      );
    }

    return Promise.resolve();
  },
  evaluate: () => Promise.resolve('Rendered  text with   substance here'),
  close: () => Promise.resolve(),
};

vi.mock('playwright', () => ({
  chromium: {
    launch: () =>
      Promise.resolve({
        newContext: () =>
          Promise.resolve({
            route: () => Promise.resolve(),
            newPage: () => Promise.resolve(mockPage),
          }),
        close: () => Promise.resolve(),
      }),
  },
}));

const fakeSite = (html: string | Error) => {
  const paced: string[] = [];
  const mockRequest: SiteRequest = (options) => {
    return html instanceof Error
      ? Promise.reject(html)
      : Promise.resolve({
          url: options.url,
          status: 200,
          contentType: 'text/html',
          body: Buffer.from(html),
          isTruncated: false,
          hops: [{ url: options.url, status: 200 }],
        });
  };
  const mockPace: HostPacer = (url, send) => {
    paced.push(url.href);

    return send();
  };

  return { paced, site: { request: mockRequest, pace: mockPace } };
};

afterEach(() => {
  browser.goto.mockReset();
  browser.waitForLoadState.mockReset();
  browser.settles = true;
});

describe('renderability - runRenderabilityCheck()', () => {
  it('should read the rendered text of a page that never goes network-idle', async () => {
    browser.settles = false;
    const { paced, site } = fakeSite(
      '<html><body><p>Rendered text with substance here</p></body></html>',
    );
    const { runRenderabilityCheck } = await import('./renderability');

    const [page] = await runRenderabilityCheck(
      ['https://example.com/docs/'],
      site,
    );

    expect(page).toMatchObject({
      url: 'https://example.com/docs/',
      error: null,
      flagged: false,
    });
    expect(page?.renderedTextChars).toBeGreaterThan(0);
    expect(browser.goto).toHaveBeenCalledWith(
      'https://example.com/docs/',
      expect.objectContaining({ waitUntil: 'load' }),
    );
    expect(browser.waitForLoadState).toHaveBeenCalledWith('networkidle');
    // The render is spaced like any other request to the host.
    expect(paced).toEqual(['https://example.com/docs/']);
  });

  it('should NOT flag a small page whose text only exists after JavaScript', async () => {
    const { site } = fakeSite('<html><body></body></html>');
    const { runRenderabilityCheck } = await import('./renderability');

    const [page] = await runRenderabilityCheck(
      ['https://example.com/app'],
      site,
    );

    expect(page).toMatchObject({ error: null, staticTextChars: 0 });
    // Small pages fall under the absolute threshold: not flagged for a
    // cookie banner's worth of text.
    expect(page?.flagged).toBe(false);
  });

  it('should record a static fetch the guard refused as the page error, and NOT render it', async () => {
    const { paced, site } = fakeSite(
      new SourceRetrievalError(
        'unsafe_destination',
        'Source must use public HTTPS with no credentials: example.com.',
      ),
    );
    const { runRenderabilityCheck } = await import('./renderability');

    const [page] = await runRenderabilityCheck(
      ['https://example.com/pricing'],
      site,
    );

    expect(page?.error).toMatch(/^unsafe_destination: /);
    expect(paced).toEqual([]);
    expect(browser.goto).not.toHaveBeenCalled();
  });
});
