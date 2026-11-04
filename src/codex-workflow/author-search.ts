import { createDataForSeoSearchAdapter } from '../grounding/tools';

// ============================================================================
// The search side of the author's research tools (specs/aeo-codex-author-spec
// §4, §12): DataForSEO organic search, returning snippets. The author reads
// pages through `fetch`, never through search results: in the sessions
// journalled with page-text search (Exa, removed 3 November 2026), not one
// search hit was fetched afterwards.
// ============================================================================

export type SearchHit = {
  url: string;
  title: string;
  publishedDate: string | null;
  /** The provider's snippet, bounded by the provider request. */
  text: string;
};

export type SearchProvider = 'dataforseo-google-organic-v1';

export type SearchOutcome = {
  provider: SearchProvider;
  results: SearchHit[];
  /** What the provider reported for the call; null when it reports nothing. */
  costUsd: number | null;
};

export type AuthorSearchAdapter = {
  provider: SearchProvider;
  search(query: string, signal: AbortSignal): Promise<SearchOutcome>;
};

/** DataForSEO organic search: snippets. */
export const createDataForSeoAuthorSearch = (args: {
  login: string;
  password: string;
}): AuthorSearchAdapter => {
  const inner = createDataForSeoSearchAdapter({
    ...args,
    locationCode: 2840,
    languageCode: 'en',
  });

  return {
    provider: 'dataforseo-google-organic-v1',
    async search(query, signal) {
      const result = await inner.search(query, signal);

      return {
        provider: 'dataforseo-google-organic-v1',
        results: result.leads.map((lead) => ({
          url: lead.url,
          title: lead.title,
          publishedDate: null,
          text: lead.snippet,
        })),
        costUsd: result.reportedCostUsd,
      };
    },
  };
};

/** The adapter the DataForSEO pair allows, else none (search refuses as
 * unavailable; fetch and render still work). */
export const searchAdapterFromEnv = (
  env: Record<string, string | undefined>,
): AuthorSearchAdapter | null => {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    return null;
  }

  return createDataForSeoAuthorSearch({
    login: env.DATAFORSEO_LOGIN,
    password: env.DATAFORSEO_PASSWORD,
  });
};
