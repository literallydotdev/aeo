// ============================================================================
// Google redirect-wrapper predicate — deliberately dependency-free (no
// node:*, no zod, no logger) because the report page's CLIENT island imports
// it via _lib/derivations. The resolver that actually fetches redirects
// lives in src/probes/grounding-urls.ts (runner-only) and re-exports these
// so probe-side callers see one module. Mirrors the console's split between
// its shared predicate and server resolver.
// ============================================================================
// Two Google surfaces wrap every cited source in an opaque redirect instead
// of the real URL. Left as-is, those wrappers collapse every citation onto
// google.com in cited-domain groupings and source mix, and make the evidence
// drawer unreadable.

// Gemini answers produced with Google Search grounding.
export const groundingRedirectUrlPrefix =
  'https://vertexaisearch.cloud.google.com/grounding-api-redirect/';

// Google AI Overview references (via DataForSEO), observed from 2026-08-28:
// the bare host 301s to the www host, which 302s to the real page.
export const googleGotoUrlPrefixes = [
  'https://google.com/goto?url=',
  'https://www.google.com/goto?url=',
] as const;

export const groundingRedirectUrlPrefixes = [
  groundingRedirectUrlPrefix,
  ...googleGotoUrlPrefixes,
] as const;

export const isGroundingRedirectUrl = (url: string): boolean => {
  return groundingRedirectUrlPrefixes.some((prefix) => url.startsWith(prefix));
};
