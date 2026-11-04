import { load } from 'cheerio';
import type { Browser } from 'playwright';
import type { AeoTechnicalChecks } from '../schema';
import { createLog } from '../lib/log';

const log = createLog('Renderability');

// ============================================================================
// Renderability check (spec §7.4): for each money page, compare the text a
// no-JS fetch yields against a Playwright-rendered version. Most AI retrieval
// bots don't execute JS — pages whose substance only exists after JS are
// invisible to them. Playwright is already a devDependency via the migration
// tooling; it is imported lazily so `--dry-run` and probe-only runs never
// need a browser installed.
// ============================================================================

const fetchTimeoutMs = 20_000;
const renderTimeoutMs = 45_000;
// How long a loaded page gets to go network-idle before its text is read as
// it stands.
const settleTimeoutMs = 8_000;
// Flag when more than 40% of the rendered text is missing statically AND the
// absolute gap is large enough to be substance, not a cookie banner.
const missingRatioThreshold = 0.4;
const missingCharsThreshold = 500;

type RenderabilityResult = NonNullable<
  AeoTechnicalChecks['renderability']
>[number];

export const runRenderabilityCheck = async (
  moneyPages: readonly string[],
): Promise<RenderabilityResult[]> => {
  if (moneyPages.length === 0) {
    return [];
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();

  try {
    const results: RenderabilityResult[] = [];

    // Sequential on purpose: one browser page, no hammering the client's site.
    for (const url of moneyPages) {
      const pageStartedAt = Date.now();
      const result = await checkPage(url, browser);

      results.push(result);
      log.debug('Renderability page checked', {
        url,
        durationMs: Date.now() - pageStartedAt,
        staticTextChars: result.staticTextChars,
        renderedTextChars: result.renderedTextChars,
        flagged: result.flagged,
        error: result.error,
      });
    }

    log.info('Renderability check completed', {
      pages: results.length,
      flagged: results.filter((r) => r.flagged).length,
      errors: results.filter((r) => r.error).length,
    });

    return results;
  } finally {
    await browser.close();
  }
};

const checkPage = async (
  url: string,
  browser: Browser,
): Promise<RenderabilityResult> => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: { 'user-agent': 'literally-aeo-audit/1.0' },
    });

    if (!response.ok) {
      return {
        url,
        staticTextChars: 0,
        renderedTextChars: 0,
        missingRatio: 0,
        flagged: false,
        error: `Static fetch failed: HTTP ${response.status}`,
      };
    }

    const staticText = extractText(await response.text());

    const page = await browser.newPage();
    let renderedText: string;

    try {
      // Load, then give the page a bounded moment to settle. Waiting for a
      // fully idle network is a trap on documentation sites, which keep a
      // connection open (live reload, search index, analytics) long after
      // the text is drawn: botpress.com/docs never went idle in 45 s and
      // the report said "could not check" for exactly the pages that
      // matter most (2026-09-15). The text is there long before.
      await page.goto(url, { waitUntil: 'load', timeout: renderTimeoutMs });
      await page
        .waitForLoadState('networkidle', { timeout: settleTimeoutMs })
        // A page that never settles is read as it stands, as explained above.
        .catch(() => undefined);
      // A document can lack a body at runtime although the DOM types say
      // otherwise; querySelector keeps that case typed.
      renderedText = normalizeWhitespace(
        await page.evaluate(
          () => document.querySelector('body')?.innerText ?? '',
        ),
      );
    } finally {
      await page.close();
    }

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
      error: String(error),
    });

    return {
      url,
      staticTextChars: 0,
      renderedTextChars: 0,
      missingRatio: 0,
      flagged: false,
      error: error instanceof Error ? error.message : String(error),
    };
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
