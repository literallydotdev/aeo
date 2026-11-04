import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGoogleAIOverview } from './dataforseo';
import { ProbeFailure, retryDelayMs } from './failure';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('dataforseo - getGoogleAIOverview()', () => {
  it.each(['api', 'task'] as const)(
    'should keep a %s-level search-engine error eligible for retry instead of recording an absent overview',
    async (level) => {
      vi.stubEnv('DATAFORSEO_LOGIN', 'test-login');
      vi.stubEnv('DATAFORSEO_PASSWORD', 'test-password');
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            status_code: level === 'api' ? 40101 : 20000,
            status_message: 'Internal SE Server Error.',
            tasks:
              level === 'task'
                ? [
                    {
                      id: 'failed-task',
                      status_code: 40101,
                      status_message: 'Internal SE Server Error.',
                      result: null,
                    },
                  ]
                : [],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            status_code: 20000,
            tasks: [
              {
                id: 'retried-task',
                status_code: 20000,
                result: [{ items: [] }],
              },
            ],
          }),
        );

      vi.stubGlobal('fetch', fetch);
      const failure = await getGoogleAIOverview(
        'test query',
        'United States',
        'en',
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ProbeFailure);
      expect(failure).toMatchObject({ kind: 'cli_error' });
      expect(retryDelayMs((failure as ProbeFailure).kind, 1)).not.toBeNull();
      await expect(
        getGoogleAIOverview('test query', 'United States', 'en'),
      ).resolves.toEqual({ status: 'no_overview' });

      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('should still stop immediately when the API rejects its credentials', async () => {
    vi.stubEnv('DATAFORSEO_LOGIN', 'test-login');
    vi.stubEnv('DATAFORSEO_PASSWORD', 'test-password');
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        status_code: 40100,
        status_message: 'Unauthorized',
        tasks: [],
      }),
    );

    vi.stubGlobal('fetch', fetch);
    const failure = await getGoogleAIOverview(
      'test query',
      'United States',
      'en',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProbeFailure);
    expect(failure).toMatchObject({ kind: 'auth' });
    expect(retryDelayMs((failure as ProbeFailure).kind, 1)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
