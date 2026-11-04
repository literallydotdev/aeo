import type { AeoVisibility, SourceCategory, SourceMixCounts } from './schema';
import { hostMatchesDomain } from './domain-match';
import { qualifiedCompetitorsForRow } from './qualified-competitors';

// ============================================================================
// Citation source classification (spec §7.1). Deterministic domain matcher
// over the config and two static rosters, then the labels the run learned
// (§7.1 amendment; built in domain-classifier.ts). Renders as the
// citation-mix breakdown per surface: the "Perplexity leans Reddit, AI
// Overviews lean YouTube" insight.
// ============================================================================

// Static community/social roster from the spec.
const socialDomains = [
  'reddit.com',
  'youtube.com',
  'youtu.be',
  'stackoverflow.com',
  'stackexchange.com',
  'github.com',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'medium.com',
  'dev.to',
  'news.ycombinator.com',
  'ycombinator.com',
];

// Wikipedia + docs of major platforms — encyclopedic/platform reference, not
// winnable press.
const institutionalDomains = [
  'wikipedia.org',
  'wikimedia.org',
  'developer.mozilla.org',
  'docs.aws.amazon.com',
  'cloud.google.com',
  'learn.microsoft.com',
  'azure.microsoft.com',
  'kubernetes.io',
  'python.org',
  'nodejs.org',
  'pytorch.org',
  'huggingface.co',
  'arxiv.org',
];

export type SourceClassifierConfig = {
  brandDomain: string;
  competitorDomains: string[];
  // Per-report overrides win over every static list ('example.com': 'earned').
  overrides?: Record<string, SourceCategory>;
  // Labels the run learned for hosts the static rules would leave as earned
  // (§7.1 amendment, 2026-09-04): qualified competitor domains and domains
  // a model labeled in the market's context.
  // Consulted after every static list, so a static answer never changes.
  // Built by src/analysis/domain-classifier.ts; absent in unit tests and in
  // consumers that only need the static rules.
  learned?: Record<string, SourceCategory>;
  // Contextual entity qualification can rule out a competitor label without
  // deciding whether the cited source is earned, social, or institutional.
  excludedCompetitorDomains?: readonly string[];
};

/** Keep a report-wide source cache from importing another section's competitors. */
export const sectionSourceClassifierConfig = (
  config: SourceClassifierConfig,
  visibility: AeoVisibility,
  sections: ReadonlyArray<{ visibility: AeoVisibility }>,
): SourceClassifierConfig => {
  const qualified = new Set<string>();

  for (const row of visibility.matrix) {
    for (const brand of qualifiedCompetitorsForRow(row)) {
      if (brand.domain) {
        qualified.add(brand.domain);
      }
    }

    // Historical rows still know their section's configured source roster,
    // even when that particular answer did not mention every competitor.
    if (row.qualifiedCompetitors === undefined) {
      for (const competitor of row.competitors) {
        qualified.add(competitor.domain);
      }
    }
  }

  const known = new Set(config.competitorDomains);

  for (const section of sections) {
    for (const row of section.visibility.matrix) {
      for (const brand of [
        ...(row.mentionedBrands ?? []),
        ...qualifiedCompetitorsForRow(row),
        ...row.competitors,
      ]) {
        if (brand.domain) {
          known.add(brand.domain);
        }
      }
    }
  }

  const excluded = [...known].filter(
    (domain) =>
      ![...qualified].some((other) => sameDomainFamily(domain, other)),
  );

  return {
    ...config,
    competitorDomains: [...qualified],
    excludedCompetitorDomains: [
      ...(config.excludedCompetitorDomains ?? []),
      ...excluded,
    ],
  };
};

export const competitorSourceAllowed = (
  host: string,
  config: SourceClassifierConfig,
): boolean => {
  return !(config.excludedCompetitorDomains ?? []).some((domain) =>
    sameDomainFamily(host, domain),
  );
};

const sameDomainFamily = (a: string, b: string): boolean => {
  return hostMatchesDomain(a, b) || hostMatchesDomain(b, a);
};

/** Classifies one cited URL's domain. Returns null for unparseable URLs. */
export const classifySource = (
  url: string,
  config: SourceClassifierConfig,
): SourceCategory | null => {
  let host: string;

  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  // Same host matcher as deterministic citation (domain-match.ts), so a URL
  // that counts as a brand citation always classifies as owned.
  const overrides = config.overrides ?? {};

  for (const [domain, category] of Object.entries(overrides)) {
    if (hostMatchesDomain(host, domain)) {
      return category;
    }
  }

  if (hostMatchesDomain(host, config.brandDomain)) {
    return 'owned';
  }

  const competitorAllowed = competitorSourceAllowed(host, config);

  for (const domain of competitorAllowed ? config.competitorDomains : []) {
    if (hostMatchesDomain(host, domain)) {
      return 'competitor';
    }
  }

  if (socialDomains.some((domain) => hostMatchesDomain(host, domain))) {
    return 'social';
  }

  if (institutionalDomains.some((domain) => hostMatchesDomain(host, domain))) {
    return 'institutional';
  }

  for (const [domain, category] of Object.entries(config.learned ?? {})) {
    if (category === 'competitor' && !competitorAllowed) {
      continue;
    }

    if (hostMatchesDomain(host, domain)) {
      return category;
    }
  }

  // Everything else: press, blogs, listicles — the winnable earned pool.
  return 'earned';
};

// Only a hostname made of DNS labels is a source; the URL parser accepts
// stray punctuation that no registrar would.
const dnsHostnameRegex =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Lower-cased host with `www.` stripped; null for unparseable URLs. */
export const citedHost = (url: string): string | null => {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');

    return dnsHostnameRegex.test(host) ? host : null;
  } catch {
    return null;
  }
};

export const emptySourceMixCounts = (): SourceMixCounts => {
  return { owned: 0, competitor: 0, social: 0, institutional: 0, earned: 0 };
};

/** Tallies classified citations for a batch of URLs. */
export const countSources = (
  urls: readonly string[],
  config: SourceClassifierConfig,
): SourceMixCounts => {
  const counts = emptySourceMixCounts();

  for (const url of urls) {
    const category = classifySource(url, config);

    if (category) {
      counts[category] += 1;
    }
  }

  return counts;
};

export const addSourceMixCounts = (
  a: SourceMixCounts,
  b: SourceMixCounts,
): SourceMixCounts => {
  return {
    owned: a.owned + b.owned,
    competitor: a.competitor + b.competitor,
    social: a.social + b.social,
    institutional: a.institutional + b.institutional,
    earned: a.earned + b.earned,
  };
};
