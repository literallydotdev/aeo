import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCrawlerAccessCheck } from './crawler-access';

// ============================================================================
// The live half of the crawler access check against a fake origin: what a
// bot-agent refusal may and may not claim, given the browser-agent control
// from the same address, and that probes go out one at a time.
// ============================================================================

type FakeFetchOptions = {
  robots?: string;
};

const stubFetch = (
  statusFor: (userAgent: string) => number,
  { robots = 'User-agent: *\nAllow: /\n' }: FakeFetchOptions = {},
) => {
  const calls: { userAgent: string; at: number }[] = [];

  const mockFetch = vi.fn((url: string, init?: RequestInit) => {
    const userAgent = new Headers(init?.headers).get('user-agent') ?? '';

    calls.push({ userAgent, at: Date.now() });

    if (url.endsWith('/robots.txt')) {
      return Promise.resolve(new Response(robots, { status: 200 }));
    }

    return Promise.resolve(new Response('', { status: statusFor(userAgent) }));
  });

  vi.stubGlobal('fetch', mockFetch);

  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('crawler-access - runCrawlerAccessCheck()', () => {
  it('should call a bot served alongside the browser control OK, and a bot refused while the browser is served "refused as bot"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stubFetch((userAgent) =>
      /PerplexityBot|Claude-User/.test(userAgent) ? 403 : 200,
    );

    const pending = runCrawlerAccessCheck('example.com');
    await vi.runAllTimersAsync();
    const result = await pending;

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
    // One request at a time, the control last.
    expect(agents.at(-1)).toContain('Chrome/128');
    expect(agents.filter((agent) => agent.includes('Chrome/128'))).toHaveLength(
      1,
    );
  });

  it('should be inconclusive when the browser control is refused too, or when a probe failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch(() => 403);

    const pending = runCrawlerAccessCheck('example.com');
    await vi.runAllTimersAsync();
    const result = await pending;

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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch(() => 200, {
      robots:
        'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
    });

    const pending = runCrawlerAccessCheck('example.com');
    await vi.runAllTimersAsync();
    const result = await pending;

    const perplexity = result.bots.find((bot) => bot.bot === 'PerplexityBot');

    expect(perplexity).toMatchObject({
      robotsAllowed: false,
      liveVerdict: 'ok',
    });
    expect(
      result.bots.find((bot) => bot.bot === 'OAI-SearchBot'),
    ).toMatchObject({ robotsAllowed: true });
  });
});
