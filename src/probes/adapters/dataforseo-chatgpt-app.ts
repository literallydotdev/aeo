import { probeUsd } from '../../models/cost-coefficients';
import type { AeoApiSurface } from '../../surfaces';
import {
  ProbeAdapterId,
  type ProbeAdapter,
  type ProbeAdapterProfile,
} from '../adapter';
import {
  chatGptEndpoint,
  chatGptTask,
  type DataForSeoLocale,
  type DataForSeoProbeClient,
} from '../dataforseo';
import { ProbeFailure } from '../failure';
import { dataForSeoAiOverviewProfile } from './dataforseo-ai-overview';
import { classifyGatewayFailure } from './gateway-chat';

// ============================================================================
// ChatGPT's web interface through DataForSEO's live scrape
// (dataforseo.chatgpt_app, method release spec §5): the consumer product,
// not the API, with its search forced on.
//
//  - The answer is the page's prose and tables (dataforseo.ts).
//  - The sources are the ones the vendor describes as "cited or relied on";
//    the methodology section says that "relied on" is included.
//  - The model is whatever the scraper read off the page. Nothing pins it,
//    so it is recorded as reported and never compared with a requested one.
//  - Retrieval is `partial`: the answer's searches as a flat list, with no
//    result set tied to any of them. The results the page showed and did
//    not cite are not kept: the retrieval log has no place for results
//    that belong to no query.
// ============================================================================

export const dataForSeoChatGptAppProfile: ProbeAdapterProfile = {
  id: ProbeAdapterId.DATAFORSEO_CHATGPT_APP,
  observes: { retrieval: 'partial', servedModel: 'raw' },
  settings: dataForSeoAiOverviewProfile.settings,
  pool: 'dataforseo',
  retry: 'chat',
  estimateUsd: probeUsd[ProbeAdapterId.DATAFORSEO_CHATGPT_APP],
  billing: 'metered',
  resolvesRedirects: false,
};

/** createDataForSeoChatGptAppAdapter asks through the run's client, in the
 * run's market. Without a client (no credentials) every probe fails as an
 * auth failure, as an unauthenticated request would. */
export const createDataForSeoChatGptAppAdapter = ({
  surface,
  client,
  locale,
}: {
  surface: AeoApiSurface;
  client: DataForSeoProbeClient | undefined;
  locale: DataForSeoLocale;
}): ProbeAdapter => {
  const adapter: ProbeAdapter = {
    ...dataForSeoChatGptAppProfile,
    surface,
    request: (promptText) => {
      const { keyword, ...parameters } = chatGptTask(promptText, locale);

      return {
        prompt: keyword,
        parameters: { endpoint: chatGptEndpoint, ...parameters },
      };
    },
    probe: async (promptText) => {
      if (!client) {
        throw new ProbeFailure('auth', 'DataForSEO credentials not configured');
      }

      const answer = await client.getChatGptAnswer(promptText, locale);

      if (answer.markdown.length === 0) {
        throw new ProbeFailure(
          'empty_answer',
          `${surface} returned an answer with no text`,
        );
      }

      return {
        answerText: answer.markdown,
        sources: {
          format: 'search',
          sources: answer.sources.map(({ url, title }) => ({
            sourceType: 'url',
            url,
            ...(title !== '' && { title }),
          })),
        },
        retrieval: {
          exposure: dataForSeoChatGptAppProfile.observes.retrieval,
          calls: answer.fanOutQueries.map((query) => ({
            kind: 'search' as const,
            query,
            url: null,
            resultUrls: null,
            resultsComplete: true,
          })),
        },
        ...(answer.model !== null && { servedModel: answer.model }),
        ...(answer.costUsd !== null && { reportedCostUsd: answer.costUsd }),
      };
    },
    classifyError: classifyGatewayFailure,
  };

  return adapter;
};
