// ============================================================================
// Surface constants and helpers — deliberately zod-free. The report page's
// client island imports from here; keeping zod out of this module keeps it
// out of the client bundle. schema.ts builds its enums from these and
// re-exports everything, so the schema stays the single source of truth for
// consumers that already work with it.
// ============================================================================

// The five chat surfaces are the canonical console set — their run counts and
// the headline scorecards computed over them stay comparable with v1
// baselines. The two agent surfaces are the v2 addition, scored separately.

export const chatSurfaces = [
  'chatgpt',
  'gemini',
  'claude',
  'perplexity',
  'google_ai_overview',
] as const;

export const agentSurfaces = ['claude_code', 'codex', 'cursor'] as const;

export const allSurfaces = [...chatSurfaces, ...agentSurfaces] as const;

export type AeoChatSurface = (typeof chatSurfaces)[number];
export type AeoAgentSurface = (typeof agentSurfaces)[number];
export type AeoSurface = (typeof allSurfaces)[number];

/** Shared display names for audit facts and report evidence. The four
 * chat surfaces ask each provider's API with web search, not its consumer
 * app, and say so (method release spec §4.3). Their IDs stay: every unit
 * key, digest, bundle and stored snapshot names them. */
export const surfaceLabels: Record<string, string> = {
  chatgpt: 'ChatGPT (API)',
  gemini: 'Gemini (API)',
  claude: 'Claude (API)',
  perplexity: 'Perplexity (API)',
  google_ai_overview: 'AI Overview',
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

export const isAgentSurface = (surface: string): surface is AeoAgentSurface => {
  return agentSurfaces.some((agentSurface) => agentSurface === surface);
};

// Runs per prompt per surface — canonical (2/2/2/2/1 for the chat surfaces,
// matching the console exactly; 2 each for the agent CLIs per spec §5).
// The default depth: a config's chatProbes and agentProbes override it, and
// runsPerPromptOn (schema.ts) is the rule every planned-run denominator
// reads, so a captured-answer shortfall lowers share of voice instead of
// hiding.
export const surfaceRunCounts: Readonly<Record<AeoSurface, number>> = {
  chatgpt: 2,
  gemini: 2,
  claude: 2,
  perplexity: 2,
  google_ai_overview: 1,
  claude_code: 2,
  codex: 2,
  cursor: 2,
};
