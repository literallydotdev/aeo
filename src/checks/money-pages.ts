import {
  SourceRetrievalError,
  validateResearchUrl,
} from '../grounding/guarded-request';
import { urlIsOnDomain } from '../report/core/domain-match';

// ============================================================================
// Which money pages the site checks may fetch and render
// (specs/aeo-checks-and-reach-spec.md §3.3). One rule for every place a
// config is admitted: audit.json, the author's output and the hosted
// platform. The verifier never applies it: stored bundles keep verifying.
// ============================================================================

export const maxMoneyPages = 20;

/** Why a money page is refused: another site's page, or a URL the guard
 * would never fetch. Each caller words the remedy its own input offers. */
export type MoneyPageProblem =
  { kind: 'off_site' } | { kind: 'unsafe_url'; message: string };

/**
 * moneyPageProblem says why the site checks may not fetch a page, or
 * undefined when they may. The page must be on the brand's site or its
 * subdomains (or on a host the operator allowed), and public https with no
 * port or credentials.
 */
export const moneyPageProblem = (
  page: string,
  site: { domain: string; checkHosts?: readonly string[] },
): MoneyPageProblem | undefined => {
  const hosts = [site.domain, ...(site.checkHosts ?? [])];

  if (!hosts.some((host) => urlIsOnDomain(page, host))) {
    return { kind: 'off_site' };
  }

  try {
    validateResearchUrl(page);
  } catch (err) {
    if (err instanceof SourceRetrievalError) {
      return { kind: 'unsafe_url', message: err.message };
    }

    throw err;
  }

  return undefined;
};
