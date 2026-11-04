import { normalizeDomain } from './normalize-domain';

// ============================================================================
// One host matcher for every domain-based decision: citation source
// classification (§7.1) and deterministic citation (correctness spec §3.4).
// `host === domain || host.endsWith('.' + domain)`, `www.` stripped on both
// sides — apex and subdomains match, look-alikes (notacme.example) don't.
// ============================================================================

export const hostMatchesDomain = (host: string, domain: string): boolean => {
  const normalizedHost = stripWww(host.toLowerCase());
  const normalizedDomain = stripWww(normalizeDomain(domain).toLowerCase());

  if (!normalizedHost || !normalizedDomain) {
    return false;
  }

  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  );
};

/** Whether a URL's host is on the domain. Unparseable URLs never match. */
export const urlIsOnDomain = (url: string, domain: string): boolean => {
  let host: string;

  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  return hostMatchesDomain(host, domain);
};

/**
 * Deterministic citation: a brand is cited in a run when some URL in the
 * run's cited URLs is on the brand's domain. Reproducible from the snapshot
 * alone — the URLs behind every citation are in the row.
 */
export const isDomainCited = (
  citedUrls: readonly string[],
  domain: string,
): boolean => {
  return citedUrls.some((url) => urlIsOnDomain(url, domain));
};

// `new URL('https://example.com./x').hostname` keeps the trailing dot.
const stripWww = (host: string): string => {
  return host.replace(/\.$/, '').replace(/^www\./, '');
};
