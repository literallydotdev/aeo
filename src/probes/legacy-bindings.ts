import type { AeoSurface } from '../surfaces';
import { ProbeAdapterId } from './adapter';

// ============================================================================
// The legacy bindings (specs/aeo-probe-adapters-spec.md §4.6): each
// surface's adapter and model as of literally-aeo 0.2.0. Frozen forever:
// a capture that records no adapter was taken with its surface's legacy
// binding. The default bindings (bindings.ts) start equal to this table and
// change only in a method release. Zod-free and SDK-free, so the progress
// projection can read it.
// ============================================================================

export type ProbeBinding = {
  adapter: ProbeAdapterId;
  /** The model a model-API adapter asks for. */
  model?: string;
};

export const legacyProbeBindings = {
  chatgpt: {
    adapter: ProbeAdapterId.GATEWAY_OPENAI,
    model: 'openai/gpt-5.4-mini',
  },
  gemini: {
    adapter: ProbeAdapterId.GATEWAY_GOOGLE,
    model: 'google/gemini-3-flash',
  },
  claude: {
    adapter: ProbeAdapterId.GATEWAY_ANTHROPIC,
    model: 'anthropic/claude-sonnet-4.5',
  },
  perplexity: {
    adapter: ProbeAdapterId.GATEWAY_PERPLEXITY,
    model: 'perplexity/sonar-pro',
  },
  google_ai_overview: { adapter: ProbeAdapterId.DATAFORSEO_AI_OVERVIEW },
  claude_code: { adapter: ProbeAdapterId.CLI_CLAUDE_CODE },
  codex: { adapter: ProbeAdapterId.CLI_CODEX },
  cursor: { adapter: ProbeAdapterId.CLI_CURSOR },
} as const satisfies Record<AeoSurface, ProbeBinding>;
