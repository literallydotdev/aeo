import { isGroundingRedirectUrl } from '../report/core/grounding';
import { normalizeDomain } from '../report/core/normalize-domain';
import type { AeoVisibility } from '../report/core/schema';

// ============================================================================
// "What gets cited": every URL a section's answers cited, grouped by domain
// as the hosted report groups them. The brand's own domain leads, even at
// zero (an answer that never cites the brand is the finding), with its
// citations split by host (site, blog, docs); every other host groups under
// its last two labels.
// ============================================================================

export type CitedUrl = {
  url: string;
  count: number;
  /** Distinct surfaces and question texts that cited the URL, first seen first. */
  surfaces: string[];
  prompts: string[];
};

export type CitedDomain = {
  domain: string;
  count: number;
  isBrand: boolean;
  /** The brand's citations by host; present on the brand's row only. */
  hosts?: Array<{ label: string; count: number }>;
  urls: CitedUrl[];
};

/** groupCitedDomains lists the brand's row first, then every other domain
 * by citations, most first. */
export const groupCitedDomains = (
  visibility: Pick<AeoVisibility, 'matrix' | 'prompts'>,
  brandDomain: string,
): CitedDomain[] => {
  const brand = normalizeDomain(brandDomain);
  const urlsByDomain = new Map<string, Map<string, CitedUrl>>();
  const brandHostCounts = new Map<string, number>();

  for (const row of visibility.matrix) {
    for (const url of row.citedUrls ?? []) {
      // An unresolved grounding redirect is an opaque wrapper, not a
      // citation of Google.
      const host = isGroundingRedirectUrl(url) ? undefined : hostOf(url);

      if (host === undefined) {
        continue;
      }

      const isBrandHost = host === brand || host.endsWith(`.${brand}`);
      const domain = isBrandHost ? brand : apexOf(host);
      const urls = urlsByDomain.get(domain) ?? new Map<string, CitedUrl>();
      const cited = urls.get(url) ?? {
        url,
        count: 0,
        surfaces: [],
        prompts: [],
      };
      const promptText = visibility.prompts[row.promptIdx]?.text;

      cited.count += 1;
      if (!cited.surfaces.includes(row.surface)) {
        cited.surfaces.push(row.surface);
      }
      if (promptText !== undefined && !cited.prompts.includes(promptText)) {
        cited.prompts.push(promptText);
      }
      urls.set(url, cited);
      urlsByDomain.set(domain, urls);
      if (isBrandHost) {
        const label = brandHostLabel(host, brand);

        brandHostCounts.set(label, (brandHostCounts.get(label) ?? 0) + 1);
      }
    }
  }

  const domainOf = (domain: string): CitedDomain => {
    const urls = [...(urlsByDomain.get(domain)?.values() ?? [])].sort(
      (a, b) => b.count - a.count || a.url.localeCompare(b.url),
    );
    const cited = {
      domain,
      count: urls.reduce((sum, url) => sum + url.count, 0),
      isBrand: domain === brand,
      urls,
    };

    return cited;
  };
  const brandRow: CitedDomain = {
    ...domainOf(brand),
    ...(brandHostCounts.size > 0 && {
      hosts: [...brandHostCounts]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
    }),
  };
  const others = [...urlsByDomain.keys()]
    .filter((domain) => domain !== brand)
    .map(domainOf)
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  const domains = [brandRow, ...others];

  return domains;
};

const hostOf = (url: string): string | undefined => {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return undefined;
  }
};

// The last two labels approximate the registrable domain (reddit.com). A
// multi-part public suffix (co.uk) collapses a level: the table is a
// grouping aid, not a registry.
const apexOf = (host: string): string => {
  const labels = host.split('.');

  return labels.length <= 2 ? host : labels.slice(-2).join('.');
};

const brandHostLabel = (host: string, brand: string): string => {
  return host === brand ? 'site' : host.slice(0, -(brand.length + 1));
};
