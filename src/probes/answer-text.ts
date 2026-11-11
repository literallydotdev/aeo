import type { RetrievalLog } from '../schema';
import type { ProbeAnswer } from './adapter';
import type { AIOverviewReference } from './dataforseo';
import { retrievalResultUrls, rewriteRetrievalUrls } from './chat-retrieval';
import {
  extractGroundingRedirectUrls,
  isGroundingRedirectUrl,
  rewriteTextUrls,
  traceGroundingRedirects,
  type RedirectResolution,
} from './grounding-urls';

// ============================================================================
// The banked answer's bytes (specs/aeo-probe-adapters-spec.md §4.4). The
// order is part of the contract, because each step changes the bytes:
//  1. render the source block after the body;
//  2. strip U+0000, so JSON snapshot files stay portable;
//  3. resolve Google's grounding redirects in the text and the retrieval
//     result sets, for the adapters that do (never the coding agents), so
//     attribution sees real targets. A probe banks the moment its own
//     redirects resolve, never after the whole batch.
// The markers below are the one copy the work directory reads.
// ============================================================================

export const searchSourcesMarker = 'Sources used by search:';
export const aiOverviewSourcesMarker = 'Sources cited in AI Overview:';

const searchSourceRows = (sources: readonly unknown[]): string[] => {
  const rows: string[] = [];

  for (const source of sources) {
    if (
      !source ||
      typeof source !== 'object' ||
      !('sourceType' in source) ||
      source.sourceType !== 'url' ||
      !('url' in source) ||
      typeof source.url !== 'string'
    ) {
      continue;
    }

    const title =
      'title' in source && typeof source.title === 'string'
        ? source.title
        : source.url;

    rows.push(`- ${title}: ${source.url}`);
  }

  return rows;
};

/** The body with its search sources appended; trimmed only when a source
 * is listed. */
const withSearchSources = (
  text: string,
  sources: readonly unknown[],
): string => {
  const rows = searchSourceRows(sources);

  if (rows.length === 0) {
    return text;
  }

  return `${text.trim()}\n\n${searchSourcesMarker}\n${rows.join('\n')}`;
};

const withAiOverviewReferences = (
  markdown: string,
  references: readonly AIOverviewReference[],
): string => {
  if (references.length === 0) {
    return markdown;
  }

  const rows = references.map((reference) => {
    // A wrapped reference (google.com/goto) reports domain "google.com" for
    // every source; its URL is resolved to the real target after the call,
    // so the misleading label is dropped rather than printed next to it.
    const domainLabel = isGroundingRedirectUrl(reference.url)
      ? ''
      : ` (${reference.domain})`;

    return `- ${reference.source}${domainLabel}: "${reference.title}" — ${reference.url}`;
  });

  return `${markdown}\n\n${aiOverviewSourcesMarker}\n${rows.join('\n')}`;
};

/** renderAnswer is the answer's text with its source block. */
export const renderAnswer = (answer: ProbeAnswer): string => {
  const { sources } = answer;

  switch (sources.format) {
    case 'search':
      return withSearchSources(answer.answerText, sources.sources);

    case 'ai_overview':
      return withAiOverviewReferences(answer.answerText, sources.references);

    case 'none':
      return answer.answerText;

    default: {
      const unhandled: never = sources;

      throw new Error(`Unhandled source format: ${String(unhandled)}.`);
    }
  }
};

export type FinalAnswer = {
  text: string;
  retrieval: RetrievalLog | null;
  /** Every redirect resolution attempted, for the journal; empty when the
   * answer named no wrapper or the adapter keeps them. */
  redirects: RedirectResolution[];
};

/** finalizeAnswer renders, strips U+0000 and resolves redirects, in that
 * order. */
export const finalizeAnswer = async (
  answer: ProbeAnswer,
  {
    resolvesRedirects,
    logContext,
  }: { resolvesRedirects: boolean; logContext?: Record<string, unknown> },
): Promise<FinalAnswer> => {
  const text = renderAnswer(answer).replaceAll('\u0000', '');

  if (!resolvesRedirects) {
    return { text, retrieval: answer.retrieval, redirects: [] };
  }

  const { resolved, resolutions } = await traceGroundingRedirects(
    [
      ...extractGroundingRedirectUrls(text),
      ...(answer.retrieval ? retrievalResultUrls(answer.retrieval) : []),
    ],
    logContext,
  );

  const finalAnswer: FinalAnswer = {
    text: rewriteTextUrls(text, resolved),
    retrieval: answer.retrieval
      ? rewriteRetrievalUrls(answer.retrieval, resolved)
      : null,
    redirects: resolutions,
  };

  return finalAnswer;
};
