import type { AeoTechnicalChecks } from '../schema';
import { createLog } from '../lib/log';

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

const fetchTimeoutMs = 15_000;
const probeIntervalMs = 1000;
const controlUserAgent =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

type LiveVerdict = 'ok' | 'refused_as_bot' | 'inconclusive';

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

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

const describeError = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

export const runCrawlerAccessCheck = async (
  brandDomain: string,
): Promise<NonNullable<AeoTechnicalChecks['crawlerAccess']>> => {
  const origin = `https://${brandDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
  const robotsUrl = `${origin}/robots.txt`;

  let robotsBody: string | null = null;
  let robotsFetchError: string | null = null;

  try {
    const response = await fetch(robotsUrl, {
      signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: { 'user-agent': 'literally-aeo-audit/1.0' },
    });

    if (response.ok) {
      robotsBody = await response.text();
    } else if (response.status === 404) {
      // No robots.txt = allow all; that is a real answer, not an error.
      robotsBody = '';
    } else {
      robotsFetchError = `HTTP ${response.status}`;
    }
  } catch (error) {
    robotsFetchError = describeError(error);
  }

  const groups = robotsBody !== null ? parseRobotsTxt(robotsBody) : null;

  // One request at a time, spaced like a polite crawler: six bot agents
  // fired at once from one address looks like an attack to a rate rule and
  // colours every answer after the first.
  const status = async (userAgent: string): Promise<number | null> => {
    try {
      const response = await fetch(origin, {
        signal: AbortSignal.timeout(fetchTimeoutMs),
        headers: { 'user-agent': userAgent },
        redirect: 'follow',
      });

      return response.status;
    } catch (error) {
      log.warn('Live UA probe failed', { userAgent, error: String(error) });

      return null;
    }
  };

  const probed: { bot: AiBot; liveStatus: number | null }[] = [];

  for (const bot of aiBotRoster) {
    if (!bot.liveProbeUa) {
      continue;
    }

    if (probed.length > 0) {
      await sleep(probeIntervalMs);
    }

    probed.push({ bot, liveStatus: await status(bot.liveProbeUa) });
  }

  // The control: the same page, from the same address, as an ordinary
  // browser. A bot agent refused while the browser is served is a request
  // that presented as that bot from an address the site cannot verify as
  // the bot's own (Cloudflare and others verify search bots by IP), so it
  // never proves the real bot is blocked. A browser refused too says the
  // address is blocked, which says nothing about bots. Botpress's report
  // called five bots blocked on that evidence (2026-09-15).
  if (probed.length > 0) {
    await sleep(probeIntervalMs);
  }

  const controlStatus =
    probed.length > 0 ? await status(controlUserAgent) : null;

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
    controlStatus,
    bots,
  };
};

export const checkLlmsTxt = async (
  brandDomain: string,
): Promise<NonNullable<AeoTechnicalChecks['llmsTxt']>> => {
  const origin = `https://${brandDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
  const [llmsTxt, llmsFullTxt] = await Promise.all([
    urlExists(`${origin}/llms.txt`),
    urlExists(`${origin}/llms-full.txt`),
  ]);

  log.debug('llms.txt check completed', { origin, llmsTxt, llmsFullTxt });

  return { llmsTxt, llmsFullTxt };
};

const urlExists = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: { 'user-agent': 'literally-aeo-audit/1.0' },
    });

    if (!response.ok) {
      return false;
    }

    // Some sites soft-404 to an HTML page; llms.txt is plain text.
    const contentType = response.headers.get('content-type') ?? '';

    return !contentType.includes('text/html');
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
