import { probeUsd } from '../../models/cost-coefficients';
import type { AeoApiSurface } from '../../surfaces';
import {
  ProbeAdapterId,
  type ProbeAdapter,
  type ProbeAdapterProfile,
} from '../adapter';
import {
  aiModeEndpoint,
  aiModeTask,
  type DataForSeoLocale,
  type DataForSeoProbeClient,
} from '../dataforseo';
import { ProbeFailure } from '../failure';
import { dataForSeoAiOverviewProfile } from './dataforseo-ai-overview';
import { classifyGatewayFailure } from './gateway-chat';

// ============================================================================
// Google AI Mode through DataForSEO's live scrape (dataforseo.ai_mode,
// method release spec §5): the consumer product, not an API. No model is
// reported and no retrieval is exposed.
//
// AI Mode always answers in the product, so nothing here is an honest
// absence: a scrape without its answer is an `empty_answer` failure, and
// its unit stays in the planned denominator as missing. An answer without
// a single reference is still an answer (4 of 48 captured ones listed
// none, 11 November 2026).
//
// The references are rendered as the source block every chat surface has,
// which the work directory keeps apart from the answer body: an answer is
// judged on what it says, never on the titles of the pages it cites. AI
// Overview's own block predates that split and keeps its bytes.
// ============================================================================

export const dataForSeoAiModeProfile: ProbeAdapterProfile = {
  id: ProbeAdapterId.DATAFORSEO_AI_MODE,
  observes: { retrieval: 'none', servedModel: 'none' },
  settings: dataForSeoAiOverviewProfile.settings,
  pool: 'dataforseo',
  retry: 'chat',
  estimateUsd: probeUsd[ProbeAdapterId.DATAFORSEO_AI_MODE],
  billing: 'metered',
  // The references are Google's, like an AI Overview's: one wrapped in a
  // Google redirect is resolved to its target.
  resolvesRedirects: true,
};

/** createDataForSeoAiModeAdapter asks through the run's client, in the
 * run's market. Without a client (no credentials) every probe fails as an
 * auth failure, as an unauthenticated request would. */
export const createDataForSeoAiModeAdapter = ({
  surface,
  client,
  locale,
}: {
  surface: AeoApiSurface;
  client: DataForSeoProbeClient | undefined;
  locale: DataForSeoLocale;
}): ProbeAdapter => {
  const adapter: ProbeAdapter = {
    ...dataForSeoAiModeProfile,
    surface,
    request: (promptText) => {
      const { keyword, ...parameters } = aiModeTask(promptText, locale);

      return {
        prompt: keyword,
        parameters: { endpoint: aiModeEndpoint, ...parameters },
      };
    },
    probe: async (promptText) => {
      if (!client) {
        throw new ProbeFailure('auth', 'DataForSEO credentials not configured');
      }

      const answer = await client.getGoogleAiMode(promptText, locale);

      if (answer.markdown.trim().length === 0) {
        throw new ProbeFailure(
          'empty_answer',
          `${surface} returned an answer with no text`,
        );
      }

      return {
        answerText: answer.markdown,
        sources: {
          format: 'search',
          sources: answer.references.flatMap(({ url, title, source }) =>
            url === ''
              ? []
              : [{ sourceType: 'url', url, title: title || source || url }],
          ),
        },
        retrieval: {
          exposure: dataForSeoAiModeProfile.observes.retrieval,
          calls: [],
        },
        ...(answer.costUsd !== null && { reportedCostUsd: answer.costUsd }),
      };
    },
    classifyError: classifyGatewayFailure,
  };

  return adapter;
};
