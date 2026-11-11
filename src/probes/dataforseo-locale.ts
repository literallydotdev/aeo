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

export const dataForSeoLanguageCodes: Readonly<Record<string, string>> = {
  en: 'en',
  english: 'en',
  es: 'es',
  spanish: 'es',
  fr: 'fr',
  french: 'fr',
  de: 'de',
  german: 'de',
  pt: 'pt',
  portuguese: 'pt',
  ja: 'ja',
  japanese: 'ja',
  zh: 'zh',
  chinese: 'zh',
  ko: 'ko',
  korean: 'ko',
  it: 'it',
  italian: 'it',
  nl: 'nl',
  dutch: 'nl',
};

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

/** When DataForSEO's lists of what each consumer scrape takes were read. */
const consumerScrapeListsReadOn = '2026-11-11';

type ConsumerScrapeMarkets = {
  /** The location codes the scrape lists, or `null` when the vendor
   * publishes no list of its own for it. */
  locationCodes: ReadonlySet<number> | null;
  languageCodes: ReadonlySet<string>;
};

// What DataForSEO lists for each consumer scrape, of the markets the tables
// above map. Read from its own lists, each a request it does not charge for:
//
//   GET /v3/ai_optimization/chat_gpt/llm_scraper/locations
//   GET /v3/ai_optimization/chat_gpt/llm_scraper/languages
//   GET /v3/serp/google/ai_mode/languages
//
// A code on a list is one the vendor takes, not a market the product was
// seen to answer in: only US English has been captured. A market that is
// mapped later is refused for these two until its codes are read here.
//
// - Chinese is listed for both scrapes only as zh-CN and zh-TW, and
//   Portuguese for AI Mode only as pt-BR. The tables above map neither
//   variant, so those markets are refused, never measured in a variant the
//   audit did not name.
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
      'ja',
      'ko',
      'it',
      'nl',
    ]),
  },
  google_ai_mode: {
    locationCodes: null,
    languageCodes: new Set(['en', 'es', 'fr', 'de', 'ja', 'ko', 'it', 'nl']),
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
  const unlisted = [
    ...(locationCodes === null || locationCodes.has(locale.locationCode)
      ? []
      : [`geography ${JSON.stringify(geography)}`]),
    ...(languageCodes.has(locale.languageCode)
      ? []
      : [`language ${JSON.stringify(language)}`]),
  ];

  return unlisted.length === 0
    ? undefined
    : `${surface} cannot be measured in ${unlisted.join(' and ')}: DataForSEO does not list it for that app (its lists were read on ${consumerScrapeListsReadOn}).`;
};
