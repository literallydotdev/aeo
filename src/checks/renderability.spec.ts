import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// The rendered half of the renderability check against a fake browser: a
// page that never goes network-idle still yields its text once loaded,
// instead of the "could not check" botpress.com/docs got (2026-09-15).
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
        newPage: () => Promise.resolve(mockPage),
        close: () => Promise.resolve(),
      }),
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  browser.goto.mockReset();
  browser.waitForLoadState.mockReset();
  browser.settles = true;
});

describe('renderability - runRenderabilityCheck()', () => {
  it('should read the rendered text of a page that never goes network-idle', async () => {
    browser.settles = false;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            '<html><body><p>Rendered text with substance here</p></body></html>',
            { status: 200 },
          ),
        ),
    );
    const { runRenderabilityCheck } = await import('./renderability');

    const [page] = await runRenderabilityCheck(['https://example.com/docs/']);

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
  });

  it('should NOT flag a small page whose text only exists after JavaScript', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html><body></body></html>', { status: 200 }),
        ),
    );
    const { runRenderabilityCheck } = await import('./renderability');

    const [page] = await runRenderabilityCheck(['https://example.com/app']);

    expect(page).toMatchObject({ error: null, staticTextChars: 0 });
    // Small pages fall under the absolute threshold: not flagged for a
    // cookie banner's worth of text.
    expect(page?.flagged).toBe(false);
  });
});
