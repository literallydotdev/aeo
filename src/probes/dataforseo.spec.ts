import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDataForSeoProbeClient } from './dataforseo';
import { ProbeFailure, retryDelayMs } from './failure';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const usMarket = { locationCode: 2840, languageCode: 'en' };

const client = () => {
  return createDataForSeoProbeClient({
    login: 'test-login',
    password: 'test-password',
  });
};

const failureOf = async (work: Promise<unknown>): Promise<ProbeFailure> => {
  const failure = await work.catch((error: unknown) => error);

  if (!(failure instanceof ProbeFailure)) {
    throw new Error('Expected a ProbeFailure.');
  }

  return failure;
};

describe('dataforseo - createDataForSeoProbeClient()', () => {
  it.each(['api', 'task'] as const)(
    'should keep a %s-level search-engine error eligible for retry instead of recording an absent overview',
    async (level) => {
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
      const serp = client();
      const failure = await failureOf(
        serp.getGoogleAIOverview('test query', usMarket),
      );

      expect(failure.kind).toBe('cli_error');
      expect(retryDelayMs(failure.kind, 1)).not.toBeNull();
      await expect(
        serp.getGoogleAIOverview('test query', usMarket),
      ).resolves.toEqual({ status: 'no_overview' });

      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('should still stop immediately when the API rejects its credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        status_code: 40100,
        status_message: 'Unauthorized',
        tasks: [],
      }),
    );

    vi.stubGlobal('fetch', fetch);
    const failure = await failureOf(
      client().getGoogleAIOverview('test query', usMarket),
    );

    expect(failure.kind).toBe('auth');
    expect(retryDelayMs(failure.kind, 1)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should authenticate with the credentials it was given, whatever the environment holds', async () => {
    vi.stubEnv('DATAFORSEO_LOGIN', 'environment-login');
    vi.stubEnv('DATAFORSEO_PASSWORD', 'environment-password');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ status_code: 20000, result: [{ items: [] }] }],
      }),
    );

    vi.stubGlobal('fetch', fetch);
    await client().getGoogleAIOverview('test query', usMarket);

    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;

    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('test-login:test-password').toString('base64')}`,
    );
  });

  it('should refuse a client without both credentials', () => {
    expect(() =>
      createDataForSeoProbeClient({ login: 'test-login', password: '' }),
    ).toThrow(/both DataForSEO credentials/);
  });

  it('should stop reading a response larger than its limit', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        sent += 1;
        controller.enqueue(chunk);
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );
    const failure = await failureOf(
      client().getGoogleAIOverview('test query', usMarket),
    );

    expect(failure.message).toMatch(/exceeds \d+ bytes/);
    expect(sent).toBeLessThan(16);
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    [
      'a document of another shape',
      JSON.stringify({ status_code: 'ok', tasks: [] }),
    ],
    [
      'an AI Overview without readable markdown',
      JSON.stringify({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            result: [{ items: [{ type: 'ai_overview', markdown: 42 }] }],
          },
        ],
      }),
    ],
  ])('should fail %s as a parser failure', async (_case, text) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(text, { status: 200 })),
    );
    const failure = await failureOf(
      client().getGoogleAIOverview('test query', usMarket),
    );

    expect(failure.kind).toBe('parser');
  });
});
