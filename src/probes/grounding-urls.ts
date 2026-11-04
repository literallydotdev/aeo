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

/**
 * Resolves every unique grounding-redirect URL in `urls` to its real target.
 * Returns a map of redirect URL → resolved URL; failures are simply absent
 * (callers keep the original URL), so a flaky redirect never fails a run.
 * Runs a sliding-window worker pool so one slow URL only delays its own
 * slot, not a whole batch.
 */
export const resolveGroundingRedirects = async (
  urls: Iterable<string>,
  logContext: Record<string, unknown> = {},
): Promise<Map<string, string>> => {
  const unique = [...new Set([...urls].filter(isGroundingRedirectUrl))];
  const resolved = new Map<string, string>();

  if (unique.length === 0) {
    return resolved;
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

        const target = await resolveOne(url);

        if (target) {
          resolved.set(url, target);
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

  return resolved;
};

const resolveOne = async (url: string): Promise<string | null> => {
  try {
    let current = url;

    for (let hop = 0; hop < maxRedirectHops; hop += 1) {
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(resolveTimeoutMs),
      });

      const location = response.headers.get('location');

      if (response.status < 300 || response.status >= 400 || !location) {
        // A non-redirect answer carries a body nobody reads; release it.
        await response.body?.cancel().catch(() => undefined);

        return null;
      }

      await response.body?.cancel().catch(() => undefined);
      const target = new URL(location, current);

      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return null;
      }

      // Off the allow-list means we reached the real page: record it.
      if (!isGroundingRedirectUrl(target.href)) {
        return target.href;
      }

      current = target.href;
    }

    // Still on a wrapper after the hop budget — treat as unresolved.
    return null;
  } catch (error) {
    log.warn('Failed to resolve grounding redirect', {
      url: url.slice(0, 120),
      error: error instanceof Error ? error.message : String(error),
    });

    return null;
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
