import { streamText } from 'ai';
import { gatewayCostUsd } from '../../models/gateway-cost';
import { probeUsd } from '../../models/cost-coefficients';
import type { AeoChatSurface } from '../../surfaces';
import {
  ProbeAdapterId,
  type ChatModelProvider,
  type ProbeAdapter,
  type ProbeAdapterProfile,
} from '../adapter';
import { ProbeFailure } from '../failure';
import {
  chatProbeTimeoutMs,
  classifyGatewayFailure,
  probeMaxOutputTokens,
  reportedCostOf,
  searchPromptPrefix,
} from './gateway-chat';

// ============================================================================
// Perplexity through the Vercel AI Gateway (gateway.perplexity): the model
// searches on its own, with no tool to require, and exposes no queries.
// It cites with bare numeric markers ([1], [2]) and returns the URLs behind
// them out of band in `sources`, rendered like the other search surfaces so
// citation extraction sees them.
// ============================================================================

export const gatewayPerplexityProfile: ProbeAdapterProfile = {
  id: ProbeAdapterId.GATEWAY_PERPLEXITY,
  observes: { retrieval: 'none', servedModel: 'compare_to_requested' },
  settings: [{ name: 'AI_GATEWAY_API_KEY', secret: true }],
  pool: 'gateway',
  retry: 'chat',
  estimateUsd: probeUsd.perplexity,
  billing: 'metered',
  resolvesRedirects: true,
};

/** createGatewayPerplexityAdapter asks `model` on `surface` through the
 * run's `gateway`. */
export const createGatewayPerplexityAdapter = ({
  surface,
  gateway,
  model,
}: {
  surface: AeoChatSurface;
  gateway: ChatModelProvider;
  model: string;
}): ProbeAdapter => {
  const adapter: ProbeAdapter = {
    ...gatewayPerplexityProfile,
    surface,
    model,
    request: (promptText) => ({
      prompt: `${searchPromptPrefix}${promptText}`,
      parameters: { model, maxOutputTokens: probeMaxOutputTokens },
    }),
    probe: async (promptText) => {
      let streamFailure: unknown;
      const stream = streamText({
        onError: ({ error }) => {
          streamFailure ??= error;
        },
        model: gateway(model),
        prompt: `${searchPromptPrefix}${promptText}`,
        maxOutputTokens: probeMaxOutputTokens,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(chatProbeTimeoutMs),
      });

      const [text, sources, response, providerMetadata] = await Promise.all([
        stream.text,
        stream.sources,
        stream.response,
        stream.providerMetadata,
      ]).catch((error: unknown) => {
        throw streamFailure ?? error;
      });

      // Checked before the sources are rendered: sources alone are no
      // answer.
      if (text.trim().length === 0) {
        throw new ProbeFailure(
          'empty_answer',
          'perplexity returned no answer text',
        );
      }

      return {
        answerText: text,
        sources: { format: 'search', sources },
        retrieval: {
          exposure: gatewayPerplexityProfile.observes.retrieval,
          calls: [],
        },
        servedModel: response.modelId,
        ...reportedCostOf([gatewayCostUsd(providerMetadata)]),
      };
    },
    classifyError: classifyGatewayFailure,
  };

  return adapter;
};
