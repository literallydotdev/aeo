import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDataForSeoSearchAdapter,
  researchToolTimeoutOf,
  searchTimeoutMs,
} from './tools';

// A search waits for DataForSEO's live scrape of Google. In a recorded
// author session every search was cut off at 15 seconds, and the session
// proposed its audit from the pages it had read alone.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tools - createDataForSeoSearchAdapter()', () => {
  it('should wait a minute for a search, not the 15 seconds every recorded one outlasted', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          status_code: 20000,
          cost: 0.002,
          tasks: [
            {
              status_code: 20000,
              result: [
                {
                  items: [
                    {
                      type: 'organic',
                      url: 'https://acme.example/pricing',
                      title: 'Acme pricing',
                      description: 'What Acme Files costs.',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    vi.stubGlobal('fetch', fetch);

    try {
      const adapter = createDataForSeoSearchAdapter({
        login: 'test-login',
        password: 'test-password',
        locationCode: 2840,
        languageCode: 'en',
      });

      await adapter.search('Which store?', new AbortController().signal);

      expect(searchTimeoutMs).toBe(60_000);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('tools - researchToolTimeoutOf()', () => {
  it('should give a search the minute and a page read its 15 seconds', () => {
    expect(researchToolTimeoutOf({ tool: 'search_sources' })).toBe(60_000);
    expect(researchToolTimeoutOf({ tool: 'fetch_source' })).toBe(15_000);
    expect(researchToolTimeoutOf({ tool: 'read_saved_evidence' })).toBe(15_000);
  });
});
