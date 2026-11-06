import {
  describeSiteError,
  type SiteRequest,
} from '../grounding/guarded-request';
import { createLog } from '../lib/log';
import type { AeoTechnicalChecks } from '../schema';

const log = createLog('CrawlerAccess');

// ============================================================================
// AI crawler access check (spec §7.4): robots.txt evaluated against the AI
// bot roster, plus a live GET with each search-bot UA to catch WAF-level
// blocks robots.txt doesn't show. The training-bot / search-bot / user-fetch
// distinction is rendered with an explanation in the report.
// ============================================================================

type BotKind = 'training' | 'search' | 'user_fetch';

type AiBot = {
  bot: string;
  kind: BotKind;
  // Real-world UA string for the live probe (search + user-fetch bots only —
  // hammering a site with training-bot UAs proves nothing about answers).
  liveProbeUa?: string;
};

export const aiBotRoster: readonly AiBot[] = [
  { bot: 'GPTBot', kind: 'training' },
  {
    bot: 'OAI-SearchBot',
    kind: 'search',
    liveProbeUa:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  },
  {
    bot: 'ChatGPT-User',
    kind: 'user_fetch',
    liveProbeUa:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  },
  { bot: 'ClaudeBot', kind: 'training' },
  {
    bot: 'Claude-User',
    kind: 'user_fetch',
    liveProbeUa:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com',
  },
  {
    bot: 'Claude-SearchBot',
    kind: 'search',
    liveProbeUa:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com',
  },
  {
    bot: 'PerplexityBot',
    kind: 'search',
    liveProbeUa:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot',
  },
  {
    bot: 'Perplexity-User',
    kind: 'user_fetch',
    liveProbeUa:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user',
  },
  { bot: 'Google-Extended', kind: 'training' },
  { bot: 'meta-externalagent', kind: 'training' },
  { bot: 'Bytespider', kind: 'training' },
  { bot: 'CCBot', kind: 'training' },
];

const requestTimeoutInMs = 15_000;
const auditUserAgent = 'literally-aeo-audit/1.0';
const controlUserAgent =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
// RFC 9309 §2.3.1.2 and §2.5: follow at least five redirects for
// robots.txt, and parse at least its first 500 KiB.
const robotsRedirects = 5;
const robotsMaxBytes = 500 * 1024;
const pageRedirects = 5;

type LiveVerdict = 'ok' | 'refused_as_bot' | 'inconclusive';

const isRefused = (code: number | null) => {
  return code === 403 || code === 429;
};

const getLiveVerdict = (
  liveStatus: number | null,
  controlStatus: number | null,
): LiveVerdict => {
  if (
    liveStatus === null ||
    controlStatus === null ||
    isRefused(controlStatus)
  ) {
    return 'inconclusive';
  }

  return isRefused(liveStatus) ? 'refused_as_bot' : 'ok';
};

const getOrigin = (brandDomain: string): string => {
  return `https://${brandDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
};

export const runCrawlerAccessCheck = async (
  brandDomain: string,
  request: SiteRequest,
): Promise<NonNullable<AeoTechnicalChecks['crawlerAccess']>> => {
  const origin = getOrigin(brandDomain);
  const robotsUrl = `${origin}/robots.txt`;

  let robotsBody: string | null = null;
  let robotsFetchError: string | null = null;
  let robotsTruncated = false;

  try {
    const response = await request({
      url: robotsUrl,
      timeoutInMs: requestTimeoutInMs,
      userAgent: auditUserAgent,
      accept: '*/*',
      redirects: robotsRedirects,
      body: {
        contentTypes: 'any',
        maxBytes: robotsMaxBytes,
        oversize: 'truncate',
      },
    });

    if (response.status >= 200 && response.status < 300) {
      robotsBody = response.body?.toString('utf8') ?? '';
      robotsTruncated = response.isTruncated;
    } else if (response.status === 404) {
      // No robots.txt = allow all; that is a real answer, not an error.
      robotsBody = '';
    } else {
      robotsFetchError = `HTTP ${response.status}`;
    }
  } catch (error) {
    robotsFetchError = describeSiteError(error);
  }

  const groups = robotsBody !== null ? parseRobotsTxt(robotsBody) : null;

  // The request is paced per host by its caller: six bot agents fired at
  // once from one address looks like an attack to a rate rule and colours
  // every answer after the first.
  const getStatus = async (userAgent: string): Promise<number | null> => {
    try {
      const response = await request({
        url: origin,
        timeoutInMs: requestTimeoutInMs,
        userAgent,
        accept: '*/*',
        redirects: pageRedirects,
      });

      return response.status;
    } catch (error) {
      log.warn('Live UA probe failed', {
        userAgent,
        error: describeSiteError(error),
      });

      return null;
    }
  };

  const probed: { bot: AiBot; liveStatus: number | null }[] = [];

  for (const bot of aiBotRoster) {
    if (!bot.liveProbeUa) {
      continue;
    }

    probed.push({ bot, liveStatus: await getStatus(bot.liveProbeUa) });
  }

  // The control: the same page, from the same address, as an ordinary
  // browser. A bot agent refused while the browser is served is a request
  // that presented as that bot from an address the site cannot verify as
  // the bot's own (Cloudflare and others verify search bots by IP), so it
  // never proves the real bot is blocked. A browser refused too says the
  // address is blocked, which says nothing about bots. An earlier report
  // called five bots blocked on that evidence.
  const controlStatus =
    probed.length > 0 ? await getStatus(controlUserAgent) : null;

  const bots = aiBotRoster.map((bot) => {
    const robotsAllowed = groups ? isRootAllowed(groups, bot.bot) : null;
    const probe = probed.find((entry) => entry.bot === bot);

    if (!probe) {
      return {
        bot: bot.bot,
        kind: bot.kind,
        robotsAllowed,
        liveStatus: null,
        liveBlocked: null,
      };
    }

    const liveStatus = probe.liveStatus;
    const liveVerdict = getLiveVerdict(liveStatus, controlStatus);

    return {
      bot: bot.bot,
      kind: bot.kind,
      robotsAllowed,
      liveStatus,
      // The live probe cannot establish a block of the real bot from here;
      // the boolean stays for readers of older snapshots and is false only
      // where the probe was served.
      liveBlocked: liveVerdict === 'ok' ? false : null,
      liveVerdict,
    };
  });

  log.info('Crawler access check completed', {
    robotsUrl,
    robotsFetchError,
    robotsTruncated,
    controlStatus,
    bots: bots.length,
    robotsBlocked: bots.filter((b) => b.robotsAllowed === false).length,
    refusedAsBot: bots.filter((b) => b.liveVerdict === 'refused_as_bot').length,
    inconclusive: bots.filter((b) => b.liveVerdict === 'inconclusive').length,
  });

  return {
    robotsUrl,
    fetchedAt: new Date().toISOString(),
    robotsFetchError,
    robotsTruncated,
    controlStatus,
    bots,
  };
};

export const checkLlmsTxt = async (
  brandDomain: string,
  request: SiteRequest,
): Promise<NonNullable<AeoTechnicalChecks['llmsTxt']>> => {
  const origin = getOrigin(brandDomain);
  // Started together, sent one after the other: the request is paced per
  // host.
  const [llmsTxt, llmsFullTxt] = await Promise.all([
    isTextFileServed(`${origin}/llms.txt`, request),
    isTextFileServed(`${origin}/llms-full.txt`, request),
  ]);

  log.debug('llms.txt check completed', { origin, llmsTxt, llmsFullTxt });

  return { llmsTxt, llmsFullTxt };
};

const isTextFileServed = async (
  url: string,
  request: SiteRequest,
): Promise<boolean> => {
  try {
    const response = await request({
      url,
      timeoutInMs: requestTimeoutInMs,
      userAgent: auditUserAgent,
      accept: 'text/plain,text/markdown,*/*',
      redirects: pageRedirects,
    });

    if (response.status < 200 || response.status >= 300) {
      return false;
    }

    // Some sites soft-404 to an HTML page; llms.txt is plain text.
    return !response.contentType.includes('text/html');
  } catch {
    // An unreachable file is reported as missing, which is what the check asks.
    return false;
  }
};

// ---------------------------------------------------------------------------
// Minimal robots.txt evaluation — user-agent groups with allow/disallow
// rules, longest-match-wins per RFC 9309, checked for the site root.
// ---------------------------------------------------------------------------

type RobotsGroup = {
  agents: string[];
  rules: { allow: boolean; path: string }[];
};

export const parseRobotsTxt = (body: string): RobotsGroup[] => {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';

    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf(':');

    if (separatorIndex < 0) {
      continue;
    }

    const field = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }

      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;

    if (!current) {
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow means "allow everything" — record nothing.
      if (value === '') {
        continue;
      }

      current.rules.push({ allow: field === 'allow', path: value });
    }
  }

  return groups;
};

/**
 * isRootAllowed tells whether `bot` may fetch the site root ('/'). The most specific matching
 * user-agent group applies (exact product token beats '*'); within it, the
 * longest matching rule wins.
 */
export const isRootAllowed = (
  groups: readonly RobotsGroup[],
  bot: string,
): boolean => {
  const botLower = bot.toLowerCase();

  let matched: RobotsGroup | null = null;
  let matchedSpecificity = -1;

  for (const group of groups) {
    for (const agent of group.agents) {
      let specificity = -1;

      if (agent === '*') {
        specificity = 0;
      } else if (botLower.includes(agent) || agent.includes(botLower)) {
        specificity = agent.length;
      }

      if (specificity > matchedSpecificity) {
        matched = group;
        matchedSpecificity = specificity;
      }
    }
  }

  if (!matched) {
    return true;
  }

  let best: { allow: boolean; length: number } | null = null;

  for (const rule of matched.rules) {
    if (!'/'.startsWith(rule.path) && rule.path !== '/') {
      continue;
    }

    if (!best || rule.path.length > best.length) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }

  return best ? best.allow : true;
};
