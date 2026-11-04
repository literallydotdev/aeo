import type {
  CitationAttribution,
  RetrievalCallSummary,
  RetrievalLog,
} from '../schema';
import { citedUrlKey } from './answer-text';
import { isDomainCited, urlIsOnDomain } from './domain-match';
import { normalizeDomain } from './scoring';

// ============================================================================
// Retrieval-log derivations computed at snapshot build (retrieval-log spec
// §6) — pure functions of stored probe data, never a model judgment, so a
// run on an unchanged checkpoint reproduces them byte for byte.
// ============================================================================

/**
 * attributeCitations applies attribution (§1): a cited URL is attributed to
 * every retrieval call whose result set contains it, matched on the normalized
 * URL key the citation dedupe uses (trailing slash and utm_* dropped). A URL in
 * no result set is unattributed (empty indices): model memory, an unexposed
 * fetch, or a surface that exposes nothing.
 */
export const attributeCitations = (
  citedUrls: readonly string[],
  retrieval: RetrievalLog,
): CitationAttribution => {
  const keysByCall = retrieval.calls.map(
    (call) =>
      new Set(
        (call.resultUrls ?? []).flatMap((url) => {
          const key = citedUrlKey(url);

          return key ? [key] : [];
        }),
      ),
  );

  return citedUrls.map((url) => {
    const key = citedUrlKey(url);
    const callIndices = key
      ? keysByCall.flatMap((keys, index) => (keys.has(key) ? [index] : []))
      : [];

    return { url, callIndices };
  });
};

/**
 * summarizeRetrievalCalls returns per-call presence for the matrix row (§6).
 * Searches: brand / competitor domains in the result set via the deterministic
 * citation matcher; an incomplete result set (ChatGPT) can prove presence but
 * not absence, so its `false` is stored as `null`. URL-driven calls: whether
 * the opened URL is on the domain. Calls with neither a query nor a URL are
 * dropped here (they stay in the chunk).
 */
export const summarizeRetrievalCalls = (
  retrieval: RetrievalLog,
  brand: { domain: string },
  competitors: ReadonlyArray<{ domain: string }>,
): RetrievalCallSummary[] => {
  const summaries: RetrievalCallSummary[] = [];

  for (const call of retrieval.calls) {
    if (call.kind === 'search') {
      if (!call.query) {
        continue;
      }

      const results = call.resultUrls;
      const found = results ? isDomainCited(results, brand.domain) : null;
      summaries.push({
        kind: 'search',
        query: call.query,
        url: null,
        brandFound:
          results && !call.resultsComplete && found === false ? null : found,
        competitorsFound: results
          ? competitors
              .filter((c) => isDomainCited(results, c.domain))
              .map((c) => normalizeDomain(c.domain))
          : [],
        resultCount: results ? results.length : null,
      });
      continue;
    }

    if (!call.url) {
      continue;
    }

    const url = call.url;
    summaries.push({
      kind: call.kind,
      query: null,
      url,
      brandFound: urlIsOnDomain(url, brand.domain),
      competitorsFound: competitors
        .filter((c) => urlIsOnDomain(url, c.domain))
        .map((c) => normalizeDomain(c.domain)),
      resultCount: null,
    });
  }

  return summaries;
};
