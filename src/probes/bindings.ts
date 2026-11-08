import type { AeoChatSurface, AeoSurface } from '../surfaces';
import {
  ProbeAdapterId,
  type ChatModelProvider,
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
import type { DataForSeoProbeClient } from './dataforseo';
import { resolveDataForSeoLocale } from './dataforseo-locale';
import { legacyProbeBindings, type ProbeBinding } from './legacy-bindings';

// ============================================================================
// Bindings (specs/aeo-probe-adapters-spec.md §4.5): which adapter, with which
// parameters, measures each surface. Until a method release changes them,
// the defaults are the legacy bindings, and they are the only bindings a run
// can have.
// ============================================================================

export type { ProbeBinding };

/**
 * What a run hands its adapters (probe adapters spec §3.1): everything an
 * adapter needs is passed in when it is created, never read from the
 * environment or a module global.
 */
export type ProbeDependencies = {
  /** The run's gateway provider, created with its own key. */
  gateway: ChatModelProvider;
  /** The run's DataForSEO client; absent when the run has no credentials,
   * which fails each AI Overview probe as an auth failure. */
  dataForSeo?: DataForSeoProbeClient;
};

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
  {
    geography,
    language,
    dependencies,
  }: { geography: string; language: string; dependencies: ProbeDependencies },
): ProbeAdapter => {
  const binding = defaultProbeBindings[surface];

  switch (binding.adapter) {
    case ProbeAdapterId.GATEWAY_OPENAI:
    case ProbeAdapterId.GATEWAY_GOOGLE:
    case ProbeAdapterId.GATEWAY_ANTHROPIC:
      return createGatewayChatAdapter(binding.adapter, {
        surface,
        gateway: dependencies.gateway,
        model: requireModel(binding, surface),
      });

    case ProbeAdapterId.GATEWAY_PERPLEXITY:
      return createGatewayPerplexityAdapter({
        surface,
        gateway: dependencies.gateway,
        model: requireModel(binding, surface),
      });

    case ProbeAdapterId.DATAFORSEO_AI_OVERVIEW: {
      const locale = resolveDataForSeoLocale(geography, language);

      // planRun refuses an unmapped market before anything runs.
      if (!locale) {
        throw new Error(
          `No DataForSEO market for geography ${geography} and language ${language}; the plan should have refused this run.`,
        );
      }

      return createDataForSeoAiOverviewAdapter({
        surface,
        client: dependencies.dataForSeo,
        locale,
      });
    }

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
