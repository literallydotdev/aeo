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
  const locationCode = dataForSeoLocationCodes[geography.toLowerCase()];
  const languageCode = dataForSeoLanguageCodes[language.toLowerCase()];

  return locationCode === undefined || languageCode === undefined
    ? undefined
    : { locationCode, languageCode };
};
