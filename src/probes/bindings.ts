import type { AeoChatSurface, AeoSurface } from '../surfaces';
import {
  ProbeAdapterId,
  type ProbeAdapter,
  type ProbeAdapterProfile,
} from './adapter';
import { cliAdapterProfiles } from './adapters/cli-agents';
import {
  createDataForSeoAiOverviewAdapter,
  dataForSeoAiOverviewProfile,
} from './adapters/dataforseo-ai-overview';
import {
  createGatewayChatAdapter,
  gatewayChatProfiles,
} from './adapters/gateway-chat';
import {
  createGatewayPerplexityAdapter,
  gatewayPerplexityProfile,
} from './adapters/gateway-perplexity';
import { legacyProbeBindings, type ProbeBinding } from './legacy-bindings';

// ============================================================================
// Bindings (specs/aeo-probe-adapters-spec.md §4.5): which adapter, with which
// parameters, measures each surface. Until a method release changes them,
// the defaults are the legacy bindings, and they are the only bindings a run
// can have.
// ============================================================================

export type { ProbeBinding };

export const defaultProbeBindings: Readonly<Record<AeoSurface, ProbeBinding>> =
  legacyProbeBindings;

/** Every registered adapter's profile, by ID. */
export const probeAdapterProfiles: Readonly<
  Record<ProbeAdapterId, ProbeAdapterProfile>
> = {
  [ProbeAdapterId.GATEWAY_OPENAI]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_OPENAI],
  [ProbeAdapterId.GATEWAY_GOOGLE]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_GOOGLE],
  [ProbeAdapterId.GATEWAY_ANTHROPIC]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_ANTHROPIC],
  [ProbeAdapterId.GATEWAY_PERPLEXITY]: gatewayPerplexityProfile,
  [ProbeAdapterId.DATAFORSEO_AI_OVERVIEW]: dataForSeoAiOverviewProfile,
  [ProbeAdapterId.CLI_CLAUDE_CODE]: cliAdapterProfiles.claude_code,
  [ProbeAdapterId.CLI_CODEX]: cliAdapterProfiles.codex,
  [ProbeAdapterId.CLI_CURSOR]: cliAdapterProfiles.cursor,
};

/** The profile of the adapter `surface` is bound to by default. */
export const defaultProfileOf = (surface: AeoSurface): ProbeAdapterProfile => {
  return probeAdapterProfiles[defaultProbeBindings[surface].adapter];
};

/** createChatAdapter is the adapter `surface` is bound to by default, asking
 * in the run's market. */
export const createChatAdapter = (
  surface: AeoChatSurface,
  { geography, language }: { geography: string; language: string },
): ProbeAdapter => {
  const binding = defaultProbeBindings[surface];

  switch (binding.adapter) {
    case ProbeAdapterId.GATEWAY_OPENAI:
    case ProbeAdapterId.GATEWAY_GOOGLE:
    case ProbeAdapterId.GATEWAY_ANTHROPIC:
      return createGatewayChatAdapter(binding.adapter, {
        surface,
        model: requireModel(binding, surface),
      });

    case ProbeAdapterId.GATEWAY_PERPLEXITY:
      return createGatewayPerplexityAdapter({
        surface,
        model: requireModel(binding, surface),
      });

    case ProbeAdapterId.DATAFORSEO_AI_OVERVIEW:
      return createDataForSeoAiOverviewAdapter({
        surface,
        geography,
        language,
      });

    case ProbeAdapterId.CLI_CLAUDE_CODE:
    case ProbeAdapterId.CLI_CODEX:
    case ProbeAdapterId.CLI_CURSOR:
      throw new Error(
        `Chat surface ${surface} is bound to a coding-agent adapter: ${binding.adapter}.`,
      );

    default: {
      const unhandled: never = binding.adapter;

      throw new Error(`Unhandled probe adapter: ${String(unhandled)}.`);
    }
  }
};

const requireModel = (binding: ProbeBinding, surface: AeoSurface): string => {
  if (binding.model === undefined) {
    throw new Error(
      `The binding of ${surface} names no model for ${binding.adapter}.`,
    );
  }

  return binding.model;
};
