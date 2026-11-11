import type { AeoConsumerSurface } from '../surfaces';

// ============================================================================
// DataForSEO's location and language codes for the geographies and
// languages an audit config names. Kept apart from the probe so a config
// can be validated, and grounding search placed in the config's market,
// without loading the network client.
// ============================================================================

export const dataForSeoLocationCodes: Readonly<Record<string, number>> = {
  'us': 2840,
  'united states': 2840,
  'gb': 2826,
  'united kingdom': 2826,
  'ca': 2124,
  'canada': 2124,
  'au': 2036,
  'australia': 2036,
  'de': 2276,
  'germany': 2276,
  'fr': 2250,
  'france': 2250,
  'es': 2724,
  'spain': 2724,
  'it': 2380,
  'nl': 2528,
  'br': 2076,
  'brazil': 2076,
  'in': 2356,
  'india': 2356,
  'jp': 2392,
  'japan': 2392,
  'se': 2752,
  'no': 2578,
  'dk': 2208,
};

// When DataForSEO's own lists of locations and languages were read: each is
// a request it does not charge for.
const listsReadOn = '2026-11-11';

// Every code is on DataForSEO's list of Google's languages
// (GET /v3/serp/google/languages), the list Google AI Overviews and the
// grounding searches are placed by. It holds Chinese only as zh-CN
// (Simplified) and zh-TW (Traditional): an audit names the one it means,
// and a plain "zh" is refused like any language no row maps, never sent to
// Google as a code it does not list.
export const dataForSeoLanguageCodes: Readonly<Record<string, string>> = {
  'en': 'en',
  'english': 'en',
  'es': 'es',
  'spanish': 'es',
  'fr': 'fr',
  'french': 'fr',
  'de': 'de',
  'german': 'de',
  'pt': 'pt',
  'portuguese': 'pt',
  'pt-br': 'pt-BR',
  'pt-pt': 'pt-PT',
  'ja': 'ja',
  'japanese': 'ja',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
  'ko': 'ko',
  'korean': 'ko',
  'it': 'it',
  'italian': 'it',
  'nl': 'nl',
  'dutch': 'nl',
};

const supportedGeographies = Object.keys(dataForSeoLocationCodes).filter(
  (key) => key.length === 2,
);
const supportedLanguages = [...new Set(Object.values(dataForSeoLanguageCodes))];

/** The markets an audit can name, for the message that refuses another. */
export const supportedMarkets = `Supported geographies: ${supportedGeographies.join(', ')}. Supported languages: ${supportedLanguages.join(', ')}.`;

/** resolveDataForSeoLocale maps a config's market, or undefined when either
 * half has no code: the caller decides, never a silent default here. */
export const resolveDataForSeoLocale = (
  geography: string,
  language: string,
): { locationCode: number; languageCode: string } | undefined => {
  const geographyKey = geography.toLowerCase();
  const languageKey = language.toLowerCase();

  // Own keys only: "constructor" or "__proto__" is not a market.
  if (
    !Object.hasOwn(dataForSeoLocationCodes, geographyKey) ||
    !Object.hasOwn(dataForSeoLanguageCodes, languageKey)
  ) {
    return undefined;
  }

  const locationCode = dataForSeoLocationCodes[geographyKey];
  const languageCode = dataForSeoLanguageCodes[languageKey];

  return locationCode === undefined || languageCode === undefined
    ? undefined
    : { locationCode, languageCode };
};

type ConsumerScrapeMarkets = {
  /** The location codes the scrape lists, or `null` when the vendor
   * publishes no list of its own for it. */
  locationCodes: ReadonlySet<number> | null;
  languageCodes: ReadonlySet<string>;
};

// What DataForSEO lists for each consumer scrape, of the markets the tables
// above map. Read from its own lists:
//
//   GET /v3/ai_optimization/chat_gpt/llm_scraper/locations
//   GET /v3/ai_optimization/chat_gpt/llm_scraper/languages
//   GET /v3/serp/google/ai_mode/languages
//
// A code on a list is one the vendor takes, not a market the product was
// seen to answer in: only US English has been captured. A market that is
// mapped later is refused for these two until its codes are read here.
//
// - The ChatGPT scrape lists every market the tables map.
// - AI Mode lists Portuguese only as pt-BR. An audit in "pt" or "pt-PT" is
//   refused for it, never measured in a variant the audit did not name.
// - AI Mode takes Google's locations, as AI Overview does. The vendor
//   publishes no list of the countries where Google serves AI Mode, so no
//   location is pinned for it.
export const consumerScrapeMarkets: Readonly<
  Record<AeoConsumerSurface, ConsumerScrapeMarkets>
> = {
  chatgpt_app: {
    locationCodes: new Set([
      2840, 2826, 2124, 2036, 2276, 2250, 2724, 2380, 2528, 2076, 2356, 2392,
      2752, 2578, 2208,
    ]),
    languageCodes: new Set([
      'en',
      'es',
      'fr',
      'de',
      'pt',
      'pt-BR',
      'pt-PT',
      'ja',
      'zh-CN',
      'zh-TW',
      'ko',
      'it',
      'nl',
    ]),
  },
  google_ai_mode: {
    locationCodes: null,
    languageCodes: new Set([
      'en',
      'es',
      'fr',
      'de',
      'pt-BR',
      'ja',
      'zh-CN',
      'zh-TW',
      'ko',
      'it',
      'nl',
    ]),
  },
};

/** consumerMarketProblem says why `surface` cannot be measured in a market,
 * or undefined when DataForSEO lists both halves of it for that scrape. A
 * market the tables above cannot place is refused on its own, for every
 * surface DataForSEO places. */
export const consumerMarketProblem = (
  surface: AeoConsumerSurface,
  geography: string,
  language: string,
): string | undefined => {
  const locale = resolveDataForSeoLocale(geography, language);

  if (!locale) {
    return undefined;
  }

  const { locationCodes, languageCodes } = consumerScrapeMarkets[surface];
  const problems = [
    ...(locationCodes === null || locationCodes.has(locale.locationCode)
      ? []
      : [
          `${surface} cannot be measured in geography ${JSON.stringify(geography)}: DataForSEO does not list it for that app (read on ${listsReadOn}).`,
        ]),
    ...(languageCodes.has(locale.languageCode)
      ? []
      : [
          `${surface} cannot be measured in language ${JSON.stringify(language)}: of the languages an audit can name, DataForSEO lists ${[...languageCodes].join(', ')} for that app (read on ${listsReadOn}).`,
        ]),
  ];

  return problems.length === 0 ? undefined : problems.join(' ');
};
