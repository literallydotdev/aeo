import { describe, expect, it } from 'vitest';
import {
  SourceRetrievalError,
  type GuardedResponse,
  type SiteRequest,
} from '../grounding/guarded-request';
import { runCrawlerAccessCheck } from './crawler-access';

// ============================================================================
// The live half of the crawler access check against a fake origin: what a
// bot-agent refusal may and may not claim, given the browser-agent control
// from the same address, and what a refused or truncated fetch records. The
// guard and the spacing per host are guarded-request.spec.ts's.
// ============================================================================

type FakeSiteOptions = {
  robots?: string;
  robotsTruncated?: boolean;
  robotsError?: Error;
};

const fakeResponse = (
  url: string,
  status: number,
  { body, isTruncated = false }: { body?: string; isTruncated?: boolean } = {},
): GuardedResponse => {
  return {
    url,
    status,
    contentType: 'text/plain',
    body: body === undefined ? undefined : Buffer.from(body),
    isTruncated,
    hops: [{ url, status }],
  };
};

const fakeSite = (
  statusFor: (userAgent: string) => number | Error,
  {
    robots = 'User-agent: *\nAllow: /\n',
    robotsTruncated = false,
    robotsError,
  }: FakeSiteOptions = {},
) => {
  const calls: { url: string; userAgent: string }[] = [];

  const mockRequest: SiteRequest = (options) => {
    calls.push({ url: options.url, userAgent: options.userAgent });

    if (options.url.endsWith('/robots.txt')) {
      return robotsError
        ? Promise.reject(robotsError)
        : Promise.resolve(
            fakeResponse(options.url, 200, {
              body: robots,
              isTruncated: robotsTruncated,
            }),
          );
    }

    const status = statusFor(options.userAgent);

    return status instanceof Error
      ? Promise.reject(status)
      : Promise.resolve(fakeResponse(options.url, status));
  };

  return { calls, mockRequest };
};

describe('crawler-access - runCrawlerAccessCheck()', () => {
  it('should call a bot served alongside the browser control OK, and a bot refused while the browser is served "refused as bot"', async () => {
    const { calls, mockRequest } = fakeSite((userAgent) =>
      /PerplexityBot|Claude-User/.test(userAgent) ? 403 : 200,
    );

    const result = await runCrawlerAccessCheck('example.com', mockRequest);

    const byBot = Object.fromEntries(result.bots.map((bot) => [bot.bot, bot]));
    const agents = calls.map((call) => call.userAgent);

    expect(result.controlStatus).toBe(200);
    expect(byBot['OAI-SearchBot']).toMatchObject({
      liveStatus: 200,
      liveBlocked: false,
      liveVerdict: 'ok',
    });
    expect(byBot['PerplexityBot']).toMatchObject({
      liveStatus: 403,
      liveBlocked: null,
      liveVerdict: 'refused_as_bot',
    });
    expect(byBot['Claude-User']).toMatchObject({
      liveVerdict: 'refused_as_bot',
    });
    // Training bots are never probed live.
    expect(byBot['GPTBot']).toMatchObject({
      liveStatus: null,
      liveBlocked: null,
    });
    expect(byBot['GPTBot']).not.toHaveProperty('liveVerdict');
    // The control last.
    expect(agents.at(-1)).toContain('Chrome/128');
    expect(agents.filter((agent) => agent.includes('Chrome/128'))).toHaveLength(
      1,
    );
  });

  it('should be inconclusive when the browser control is refused too, or when a probe failed', async () => {
    const { mockRequest } = fakeSite(() => 403);

    const result = await runCrawlerAccessCheck('example.com', mockRequest);

    const probedBots = result.bots.filter((bot) => bot.liveStatus !== null);

    expect(result.controlStatus).toBe(403);
    expect(probedBots).toHaveLength(6);
    expect(
      probedBots.every(
        (bot) => bot.liveVerdict === 'inconclusive' && bot.liveBlocked === null,
      ),
    ).toBe(true);
    expect(
      result.bots.filter((bot) => bot.liveVerdict === 'inconclusive'),
    ).toHaveLength(6);
  });

  it('should keep the robots.txt verdicts independent of the live probes', async () => {
    const { mockRequest } = fakeSite(() => 200, {
      robots:
        'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
    });

    const result = await runCrawlerAccessCheck('example.com', mockRequest);

    const perplexity = result.bots.find((bot) => bot.bot === 'PerplexityBot');

    expect(perplexity).toMatchObject({
      robotsAllowed: false,
      liveVerdict: 'ok',
    });
    expect(
      result.bots.find((bot) => bot.bot === 'OAI-SearchBot'),
    ).toMatchObject({ robotsAllowed: true });
  });

  it('should record a robots.txt cut at the RFC 9309 bound as truncated', async () => {
    const { mockRequest } = fakeSite(() => 200, { robotsTruncated: true });

    const result = await runCrawlerAccessCheck('example.com', mockRequest);

    expect(result).toMatchObject({
      robotsFetchError: null,
      robotsTruncated: true,
    });
  });

  it('should record a robots.txt redirect to an unsafe destination as the reason, with no verdicts', async () => {
    const { mockRequest } = fakeSite(() => 200, {
      robotsError: new SourceRetrievalError(
        'unsafe_destination',
        'Source must use public HTTPS with no credentials: example.com.',
      ),
    });

    const result = await runCrawlerAccessCheck('example.com', mockRequest);

    expect(result.robotsFetchError).toMatch(/^unsafe_destination: /);
    expect(result.bots.every((bot) => bot.robotsAllowed === null)).toBe(true);
  });

  it('should call a live probe refused by the guard inconclusive, never blocked', async () => {
    const { mockRequest } = fakeSite((userAgent) =>
      userAgent.includes('OAI-SearchBot')
        ? new SourceRetrievalError('unsafe_destination', 'Private source.')
        : 200,
    );

    const result = await runCrawlerAccessCheck('example.com', mockRequest);

    expect(
      result.bots.find((bot) => bot.bot === 'OAI-SearchBot'),
    ).toMatchObject({
      liveStatus: null,
      liveBlocked: null,
      liveVerdict: 'inconclusive',
    });
  });
});
