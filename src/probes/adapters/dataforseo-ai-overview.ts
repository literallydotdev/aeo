import { probeUsd } from '../../models/cost-coefficients';
import type { AeoChatSurface } from '../../surfaces';
import {
  ProbeAdapterId,
  type ProbeAdapter,
  type ProbeAdapterProfile,
} from '../adapter';
import type { DataForSeoLocale, DataForSeoProbeClient } from '../dataforseo';
import { ProbeFailure } from '../failure';
import { classifyGatewayFailure } from './gateway-chat';

// ============================================================================
// Google AI Overview through DataForSEO's live SERP
// (dataforseo.ai_overview): a SERP feature, so there is no model to ask
// for and no retrieval to expose. A SERP without an AI Overview is an honest
// absence (`noOverview`), never a failure.
// ============================================================================

export const dataForSeoAiOverviewProfile: ProbeAdapterProfile = {
  id: ProbeAdapterId.DATAFORSEO_AI_OVERVIEW,
  observes: { retrieval: 'none', servedModel: 'none' },
  settings: [
    { name: 'DATAFORSEO_LOGIN', secret: false },
    { name: 'DATAFORSEO_PASSWORD', secret: true },
  ],
  pool: 'dataforseo',
  retry: 'chat',
  estimateUsd: probeUsd.google_ai_overview,
  billing: 'metered',
  resolvesRedirects: true,
};

/** createDataForSeoAiOverviewAdapter asks through the run's client, in the
 * run's market. Without a client (no credentials) every probe fails as
 * an auth failure, as an unauthenticated request would. */
export const createDataForSeoAiOverviewAdapter = ({
  surface,
  client,
  locale,
}: {
  surface: AeoChatSurface;
  client: DataForSeoProbeClient | undefined;
  locale: DataForSeoLocale;
}): ProbeAdapter => {
  const retrieval = () => {
    return {
      exposure: dataForSeoAiOverviewProfile.observes.retrieval,
      calls: [],
    };
  };

  const adapter: ProbeAdapter = {
    ...dataForSeoAiOverviewProfile,
    surface,
    probe: async (promptText) => {
      if (!client) {
        throw new ProbeFailure('auth', 'DataForSEO credentials not configured');
      }

      const result = await client.getGoogleAIOverview(promptText, locale);

      if (result.status === 'no_overview') {
        return {
          answerText: '',
          sources: { format: 'none' },
          retrieval: retrieval(),
          noOverview: true,
        };
      }

      // The rendered text is empty only when both the markdown and the
      // references are.
      if (
        result.markdown.trim().length === 0 &&
        result.references.length === 0
      ) {
        throw new ProbeFailure(
          'empty_answer',
          'google_ai_overview returned an AI Overview with no text',
        );
      }

      return {
        answerText: result.markdown,
        sources: { format: 'ai_overview', references: result.references },
        retrieval: retrieval(),
      };
    },
    classifyError: classifyGatewayFailure,
  };

  return adapter;
};
