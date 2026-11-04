// ============================================================================
// Competitor qualification version. The Codex workflow's qualify stage
// (src/codex-workflow/) decides which observed brands are buyer alternatives;
// the in-process classifier that used to live here is gone. The version is
// still written to snapshot meta (runner.ts) so a published report says which
// qualification rules produced its source mix.
//
// v5 (2026-09-13): a configured competitor's product names resolve to the
// competitor, and a brand and its product are one qualified entry. v6: an
// acronym label or a short form of a product name merges into it.
// v7: a name that appears only inside a cited URL is not a mention. v8: nor
// one inside a bare domain path or the appended sources block. v9: a bare
// domain without a path is a brand name and stays.
// ============================================================================
export const competitorClassifierVersion = 9;
