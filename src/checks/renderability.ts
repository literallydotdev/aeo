import { load } from 'cheerio';
import type { BrowserContext } from 'playwright';
import {
  withBoundedPage,
  withGuardedChromium,
} from '../grounding/chromium-guard';
import {
  describeSiteError,
  type HostPacer,
  type SiteRequest,
} from '../grounding/guarded-request';
import { createLog } from '../lib/log';
import type { AeoTechnicalChecks } from '../schema';

const log = createLog('Renderability');

// ============================================================================
// Renderability check (spec §7.4): for each money page, compare the text a
// no-JS fetch yields against a Playwright-rendered version. Most AI retrieval
// bots don't execute JS — pages whose substance only exists after JS are
// invisible to them. Playwright is imported lazily, so a run without money
// pages never needs a browser installed. Both fetches pass the guard: the
// static one through guardedRequest, the browser through the guarding
// proxy (withGuardedChromium).
// ============================================================================

const fetchTimeoutInMs = 20_000;
const renderTimeoutInMs = 45_000;
// How long a loaded page gets to go network-idle before its text is read as
// it stands.
const settleTimeoutInMs = 8_000;
// The whole render, reading the text included: past it the page is closed.
const renderDeadlineInMs = 60_000;
const staticMaxBytes = 10 * 1024 * 1024;
const pageRedirects = 5;
// Flag when more than 40% of the rendered text is missing statically AND the
// absolute gap is large enough to be substance, not a cookie banner.
const missingRatioThreshold = 0.4;
const missingCharsThreshold = 500;

type RenderabilityResult = NonNullable<
  AeoTechnicalChecks['renderability']
>[number];

/** The phase's guarded request and the pacer behind it: a page's static
 * fetch and its render are spaced like any other request to its host. */
export type PagedSite = { request: SiteRequest; pace: HostPacer };

export const runRenderabilityCheck = async (
  moneyPages: readonly string[],
  site: PagedSite,
): Promise<RenderabilityResult[]> => {
  if (moneyPages.length === 0) {
    return [];
  }

  const { result: results, connections } = await withGuardedChromium(
    async (context) => {
      const checked: RenderabilityResult[] = [];

      // Sequential on purpose: one browser page, no hammering the client's site.
      for (const url of moneyPages) {
        const pageStartedAt = Date.now();
        const result = await checkPage(url, context, site);

        checked.push(result);
        log.debug('Renderability page checked', {
          url,
          durationMs: Date.now() - pageStartedAt,
          staticTextChars: result.staticTextChars,
          renderedTextChars: result.renderedTextChars,
          flagged: result.flagged,
          error: result.error,
        });
      }

      return checked;
    },
  );

  log.info('Renderability check completed', {
    pages: results.length,
    flagged: results.filter((r) => r.flagged).length,
    errors: results.filter((r) => r.error).length,
    connections,
  });

  return results;
};

const failedPage = (url: string, error: string): RenderabilityResult => {
  return {
    url,
    staticTextChars: 0,
    renderedTextChars: 0,
    missingRatio: 0,
    flagged: false,
    error,
  };
};

const renderText = (url: string, context: BrowserContext): Promise<string> => {
  return withBoundedPage(context, renderDeadlineInMs, async (page) => {
    // Load, then give the page a bounded moment to settle. Waiting for a
    // fully idle network is a trap on documentation sites, which keep a
    // connection open (live reload, search index, analytics) long after
    // the text is drawn: one never went idle in 45 s, and the report said
    // "could not check" for exactly the pages that matter most. The text
    // is there long before.
    await page.goto(url, { waitUntil: 'load', timeout: renderTimeoutInMs });
    await page
      .waitForLoadState('networkidle', { timeout: settleTimeoutInMs })
      // A page that never settles is read as it stands, as explained above.
      .catch(() => undefined);

    // A document can lack a body at runtime although the DOM types say
    // otherwise; querySelector keeps that case typed.
    const text = await page.evaluate(
      () => document.querySelector('body')?.innerText ?? '',
    );

    return normalizeWhitespace(text);
  });
};

const checkPage = async (
  url: string,
  context: BrowserContext,
  site: PagedSite,
): Promise<RenderabilityResult> => {
  try {
    const response = await site.request({
      url,
      timeoutInMs: fetchTimeoutInMs,
      userAgent: 'literally-aeo-audit/1.0',
      accept: 'text/html,application/xhtml+xml',
      redirects: pageRedirects,
      body: {
        contentTypes: /^(text\/html|application\/xhtml\+xml|text\/plain)(;|$)/i,
        maxBytes: staticMaxBytes,
        oversize: 'refuse',
      },
    });

    if (response.status < 200 || response.status >= 300) {
      return failedPage(url, `Static fetch failed: HTTP ${response.status}`);
    }

    const staticText = extractText(response.body?.toString('utf8') ?? '');
    const renderedText = await site.pace(new URL(url), () => {
      return renderText(url, context);
    });

    const staticChars = staticText.length;
    const renderedChars = renderedText.length;
    const missingChars = Math.max(0, renderedChars - staticChars);
    const missingRatio = renderedChars > 0 ? missingChars / renderedChars : 0;
    const flagged =
      missingRatio > missingRatioThreshold &&
      missingChars > missingCharsThreshold;

    return {
      url,
      staticTextChars: staticChars,
      renderedTextChars: renderedChars,
      missingRatio: Math.round(missingRatio * 1000) / 1000,
      flagged,
      error: null,
    };
  } catch (error) {
    log.warn('Renderability check failed for page', {
      url,
      error: describeSiteError(error),
    });

    return failedPage(url, describeSiteError(error));
  }
};

const extractText = (html: string): string => {
  const $ = load(html);

  $('script, style, noscript, template').remove();

  return normalizeWhitespace($('body').text());
};

const normalizeWhitespace = (text: string): string => {
  return text.replace(/\s+/g, ' ').trim();
};
