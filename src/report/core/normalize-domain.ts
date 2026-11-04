/** Lower-cased host of a domain or URL, `www.` and trailing dot stripped. */
export const normalizeDomain = (domain: string): string => {
  let host: string;

  try {
    host = new URL(domain.includes('://') ? domain : `https://${domain}`)
      .hostname;
  } catch {
    host = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }

  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
};
