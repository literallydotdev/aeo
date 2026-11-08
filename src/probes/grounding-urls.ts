import {
  groundingRedirectUrlPrefix,
  groundingRedirectUrlPrefixes,
  isGroundingRedirectUrl,
} from '../grounding';
import { createLog } from '../lib/log';

const log = createLog('GroundingUrlResolver');

// ============================================================================
// Google redirect-wrapper resolution (ported from the console —
// apps/console/lib/intelligence/grounding-urls.ts + the shared predicate)
// ============================================================================
// Gemini grounding answers and Google AI Overview references cite every
// source through an opaque redirect (see aeo/grounding.ts for the wrapper
// prefixes) instead of the real URL. Left as-is, those wrappers make
// evidence drawers unreadable and collapse every citation onto google.com
// in cited-domain groupings and source mix. The redirects are public 3xx
// responses, so `runProbesForPrompts` resolves them once per probe batch —
// before analysis, so analyzers, excerpts, and cited-URL extraction all see
// real targets. Only the fixed, hardcoded prefixes are ever fetched — never
// an arbitrary model-supplied URL — and the redirect target is recorded,
// not followed. A wrapper may chain through another wrapper (google.com/goto
// 301s to www.google.com/goto before the 302 to the target), so resolution
// follows at most maxRedirectHops while each hop stays on the allow-list.

// Predicate + prefixes live in the dependency-free aeo/grounding.ts (the
// report page's client island imports them); re-exported here so probe-side
// callers keep one import path.
export { groundingRedirectUrlPrefix, isGroundingRedirectUrl };

const resolveTimeoutMs = 5_000;
const maxConcurrentResolutions = 8;
const maxRedirectHops = 3;

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Maximal non-delimiter run after a fixed prefix — the same token charset
// extractHttpUrls uses. Trailing sentence punctuation is stripped per match.
const groundingUrlPattern = new RegExp(
  `(?:${groundingRedirectUrlPrefixes.map(escapeRegExp).join('|')})[^\\s)"'<>]+`,
  'g',
);

const containsRedirectPrefix = (text: string): boolean => {
  return groundingRedirectUrlPrefixes.some((prefix) => text.includes(prefix));
};

export const extractGroundingRedirectUrls = (text: string): string[] => {
  if (!containsRedirectPrefix(text)) {
    return [];
  }

  const matches = text.match(groundingUrlPattern) ?? [];

  return matches.map(stripTrailingPunctuation);
};

/** What resolving one wrapper URL found: its target, or why there is none,
 * after how many requests. Recorded in the probe's journal operation. */
export type RedirectResolution = {
  url: string;
  target: string | null;
  hops: number;
  failure?: string;
};

/**
 * Resolves every unique grounding-redirect URL in `urls` to its real target
 * and reports each attempt. `resolved` maps redirect URL → resolved URL;
 * failures are absent from it (callers keep the original URL), so a flaky
 * redirect never fails a run. Runs a sliding-window worker pool so one slow
 * URL only delays its own slot, not a whole batch.
 */
export const traceGroundingRedirects = async (
  urls: Iterable<string>,
  logContext: Record<string, unknown> = {},
): Promise<{
  resolved: Map<string, string>;
  resolutions: RedirectResolution[];
}> => {
  const unique = [...new Set([...urls].filter(isGroundingRedirectUrl))];
  const resolved = new Map<string, string>();
  const resolutions: RedirectResolution[] = [];

  if (unique.length === 0) {
    return { resolved, resolutions };
  }

  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(maxConcurrentResolutions, unique.length) },
    async () => {
      while (nextIndex < unique.length) {
        const url = unique[nextIndex];
        nextIndex += 1;

        if (!url) {
          continue;
        }

        const resolution = await resolveOne(url);

        resolutions.push(resolution);

        if (resolution.target) {
          resolved.set(url, resolution.target);
        }
      }
    },
  );

  await Promise.all(workers);

  log.info('Resolved grounding redirect URLs', {
    ...logContext,
    total: unique.length,
    resolved: resolved.size,
  });

  // In the order the URLs were found, whatever order the pool finished in.
  resolutions.sort((a, b) => unique.indexOf(a.url) - unique.indexOf(b.url));

  return { resolved, resolutions };
};

/** resolveGroundingRedirects is traceGroundingRedirects' map alone. */
export const resolveGroundingRedirects = async (
  urls: Iterable<string>,
  logContext: Record<string, unknown> = {},
): Promise<Map<string, string>> => {
  const { resolved } = await traceGroundingRedirects(urls, logContext);

  return resolved;
};

const resolveOne = async (url: string): Promise<RedirectResolution> => {
  let hops = 0;

  try {
    let current = url;

    while (hops < maxRedirectHops) {
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(resolveTimeoutMs),
      });

      hops += 1;

      const location = response.headers.get('location');

      if (response.status < 300 || response.status >= 400 || !location) {
        // A non-redirect answer carries a body nobody reads; release it.
        await response.body?.cancel().catch(() => undefined);

        return {
          url,
          target: null,
          hops,
          failure: `HTTP ${response.status} without a redirect`,
        };
      }

      await response.body?.cancel().catch(() => undefined);
      const target = new URL(location, current);

      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return {
          url,
          target: null,
          hops,
          failure: `redirect to a ${target.protocol} URL`,
        };
      }

      // Off the allow-list means we reached the real page: record it.
      if (!isGroundingRedirectUrl(target.href)) {
        return { url, target: target.href, hops };
      }

      current = target.href;
    }

    // Still on a wrapper after the hop budget — treat as unresolved.
    return {
      url,
      target: null,
      hops,
      failure: `still a redirect wrapper after ${maxRedirectHops} hops`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    log.warn('Failed to resolve grounding redirect', {
      url: url.slice(0, 120),
      error: message,
    });

    return { url, target: null, hops, failure: message.slice(0, 300) };
  }
};

/**
 * Replaces resolved redirect URLs inside free text in a single pass. Each
 * regex match is a maximal URL run looked up exactly, so one redirect URL
 * being a string prefix of another can never corrupt the longer one.
 * Unresolved redirects stay as-is.
 */
export const rewriteTextUrls = (
  text: string,
  resolved: ReadonlyMap<string, string>,
): string => {
  if (resolved.size === 0 || !containsRedirectPrefix(text)) {
    return text;
  }

  return text.replace(groundingUrlPattern, (match) => {
    const stripped = stripTrailingPunctuation(match);
    const target = resolved.get(stripped);

    return target ? target + match.slice(stripped.length) : match;
  });
};

const stripTrailingPunctuation = (url: string): string => {
  return url.replace(/[.,;:!?]+$/, '');
};
