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

// The consumer apps themselves, scraped by a vendor (method release spec
// §5): what a person sees in the product, where the chat surfaces ask each
// provider's API. Measured only when an audit asks for them, and scored as
// a family of their own, never in the chat headline.
export const consumerSurfaces = ['chatgpt_app', 'google_ai_mode'] as const;

/** The surfaces an audit measures unless it says otherwise. */
export const defaultSurfaces = [...chatSurfaces, ...agentSurfaces] as const;

/** The engine's own surfaces. A run may add custom ones (below). The
 * consumer surfaces come last, so every earlier surface keeps its place in
 * the canonical order. */
export const allSurfaces = [...defaultSurfaces, ...consumerSurfaces] as const;

export type AeoChatSurface = (typeof chatSurfaces)[number];
export type AeoAgentSurface = (typeof agentSurfaces)[number];
export type AeoConsumerSurface = (typeof consumerSurfaces)[number];
export type AeoDefaultSurface = (typeof defaultSurfaces)[number];
export type AeoBuiltInSurface = (typeof allSurfaces)[number];

// A custom surface (open models spec §5): any gateway model an audit
// declares, measured as a surface of its own. The prefix keeps its ID apart
// from every built-in one, present and future.
export const customSurfacePrefix = 'custom:';
export const customSurfaceKeyPattern = /^[a-z][a-z0-9_]{0,31}$/;

export type AeoCustomSurface = `custom:${string}`;
export type AeoSurface = AeoBuiltInSurface | AeoCustomSurface;
/** A surface asked through a model API, a search API or a scrape: every
 * surface that is not a coding agent's CLI. */
export type AeoApiSurface =
  AeoChatSurface | AeoConsumerSurface | AeoCustomSurface;

/** How many times a custom surface is asked each prompt, like the chat
 * surfaces, when the audit sets no chat depth. */
export const customSurfaceRunCount = 2;

export const isCustomSurface = (
  surface: string,
): surface is AeoCustomSurface => {
  return (
    surface.startsWith(customSurfacePrefix) &&
    customSurfaceKeyPattern.test(surface.slice(customSurfacePrefix.length))
  );
};

export const isBuiltInSurface = (
  surface: string,
): surface is AeoBuiltInSurface => {
  return allSurfaces.some((builtIn) => builtIn === surface);
};

export const isConsumerSurface = (
  surface: string,
): surface is AeoConsumerSurface => {
  return consumerSurfaces.some((consumer) => consumer === surface);
};

/** The scopes a surface is scored and compared in. */
export type SurfaceFamily = 'chat' | 'consumer' | 'agents' | 'custom';

export const surfaceFamilyOf = (surface: string): SurfaceFamily => {
  if (isAgentSurface(surface)) {
    return 'agents';
  }

  if (isConsumerSurface(surface)) {
    return 'consumer';
  }

  return isCustomSurface(surface) ? 'custom' : 'chat';
};

/** The built-in chat and search surfaces: the ones the chat headline pair
 * is scored over. A custom surface is in neither pair. */
export const isChatSurface = (surface: string): surface is AeoChatSurface => {
  return chatSurfaces.some((chatSurface) => chatSurface === surface);
};

/** Shared display names for audit facts and report evidence. The four
 * chat surfaces ask each provider's API with web search, not its consumer
 * app, and say so (method release spec §4.3). Their IDs stay: every unit
 * key, digest, bundle and stored snapshot names them. A report can measure
 * ChatGPT both ways, so the scraped app says which it is too. */
export const surfaceLabels: Record<string, string> = {
  chatgpt: 'ChatGPT (API)',
  gemini: 'Gemini (API)',
  claude: 'Claude (API)',
  perplexity: 'Perplexity (API)',
  google_ai_overview: 'AI Overview',
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  chatgpt_app: 'ChatGPT (app)',
  google_ai_mode: 'AI Mode',
};

export const isAgentSurface = (surface: string): surface is AeoAgentSurface => {
  return agentSurfaces.some((agentSurface) => agentSurface === surface);
};

// Runs per prompt per surface — canonical (2/2/2/2/1 for the chat surfaces,
// matching the console exactly; 2 each for the agent CLIs per spec §5; 1
// for each consumer app, like AI Overview).
// The default depth: a config's chatProbes and agentProbes override it, and
// runsPerPromptOn (schema.ts) is the rule every planned-run denominator
// reads, so a captured-answer shortfall lowers share of voice instead of
// hiding.
export const surfaceRunCounts: Readonly<Record<AeoBuiltInSurface, number>> = {
  chatgpt: 2,
  gemini: 2,
  claude: 2,
  perplexity: 2,
  google_ai_overview: 1,
  claude_code: 2,
  codex: 2,
  cursor: 2,
  chatgpt_app: 1,
  google_ai_mode: 1,
};
