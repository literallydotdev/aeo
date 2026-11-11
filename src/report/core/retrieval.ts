import {
  isCustomSurface,
  type AeoBuiltInSurface,
  type AeoSurface,
} from './surfaces';

// ============================================================================
// Retrieval-log constants (retrieval-log spec §1, §2) — deliberately zod-free
// like surfaces.ts: the report page's client island imports from here,
// and schema.ts builds its enums from these.
// ============================================================================

// One web search or web fetch a surface executed while answering a probe.
// `search` carries a query; the URL-driven kinds carry the target URL.
export const retrievalCallKinds = [
  'search',
  'fetch',
  'open_page',
  'find_in_page',
] as const;

export type RetrievalCallKind = (typeof retrievalCallKinds)[number];

// What a surface's stream structurally reveals about its retrieval:
//   full          queries and result sets
//   queries_only  queries, no result sets (Codex)
//   partial       queries as a flat list, sources not linked to them
//                 (Gemini, the scraped ChatGPT app)
//   none          nothing (Perplexity, Google AI Overview, Google AI Mode)
export const retrievalExposures = [
  'full',
  'queries_only',
  'partial',
  'none',
] as const;

export type RetrievalExposure = (typeof retrievalExposures)[number];

// Verified per surface on 2026-09-03 against the checked-in stream fixtures
// and the installed SDK types (spec §2). `none` is reserved for surfaces
// that structurally expose nothing — a parse miss on any other surface is
// stored as "not captured", never as `none`.
export const surfaceRetrievalExposure: Readonly<
  Record<AeoBuiltInSurface, RetrievalExposure>
> = {
  chatgpt: 'full',
  gemini: 'partial',
  claude: 'full',
  perplexity: 'none',
  google_ai_overview: 'none',
  claude_code: 'full',
  codex: 'queries_only',
  cursor: 'full',
  // Read from captured scrapes on 2026-11-11 (method release spec §5.6).
  chatgpt_app: 'partial',
  google_ai_mode: 'none',
};

/** What `surface`'s stream reveals. A custom surface is asked through the
 * gateway's search tool, which returns every result it found. */
export const retrievalExposureOf = (surface: AeoSurface): RetrievalExposure => {
  return isCustomSurface(surface) ? 'full' : surfaceRetrievalExposure[surface];
};
