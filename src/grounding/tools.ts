import { z } from 'zod';
import { contentHash } from '../stores/content-hash';
import { fetchGroundingSource } from './fetch';
import { validateResearchUrl } from './guarded-request';
import { GroundingIntegrityError } from './validation';
import {
  groundingSourceSchema,
  type GroundingSource,
  type SavedAnswer,
} from './schema';

const candidateIds = z.array(z.string().min(1).max(200)).min(1).max(40);
const relevance = z.string().min(1).max(500);

export const researchActionSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('search_sources'),
    candidateIds,
    question: relevance,
    query: z.string().min(1).max(300),
  }),
  z.object({
    tool: z.literal('fetch_source'),
    candidateIds,
    relevance,
    url: z.string().url().max(4096),
  }),
  z.object({
    tool: z.literal('read_saved_evidence'),
    candidateIds,
    relevance,
    evidenceId: z.string().min(1).max(200),
    start: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(8000),
  }),
  z.object({
    tool: z.literal('finish_research'),
    reason: z.enum([
      'evidence_ready',
      'sources_exhausted',
      'provider_unavailable',
    ]),
    relevance,
  }),
]);

export type ResearchAction = z.infer<typeof researchActionSchema>;

export type ExecutableResearchAction = Exclude<
  ResearchAction,
  { tool: 'finish_research' }
>;

export const searchLeadSchema = z.object({
  id: z.string(),
  url: z.string().url().max(4096),
  title: z.string().max(500),
  snippet: z.string().max(2000),
});

export const researchToolResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('search'),
    leads: z.array(searchLeadSchema).max(10),
    provider: z.literal('dataforseo-google-organic-v1'),
    reportedCostUsd: z.number().nonnegative().nullable(),
    providerRequestId: z.string().max(300).optional(),
  }),
  z.object({
    kind: z.literal('fetch'),
    source: groundingSourceSchema,
    links: z.array(z.string().url().max(4096)).max(100),
    requestCount: z.number().int().min(1).max(4),
  }),
  z.object({
    kind: z.literal('read'),
    evidenceId: z.string(),
    text: z.string().max(8000),
    start: z.number().int().nonnegative(),
    fullDigest: z.string(),
    capturedAt: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('failure'),
    reason: z.enum([
      'unavailable',
      'retrieval_failed',
      'unsafe_destination',
      'timeout',
      'invalid_query',
      // The model named evidence this session does not hold, or a range
      // outside the text it holds. Spec §4.3 persists a typed failure for an
      // invalid action; the boundary is enforced either way, because no text
      // is returned. Killing the run instead would discard every committed
      // operation over one bad tool argument.
      'invalid_reference',
    ]),
    retryable: z.boolean(),
  }),
]);

export type ResearchToolResult = z.infer<typeof researchToolResultSchema>;

export type GroundingToolContext = {
  sources: GroundingSource[];
  allowedUrls: readonly string[];
  signal: AbortSignal;
  beforeFetchRequest?: () => Promise<void>;
};

export type GroundingTools = {
  searchProvider: 'dataforseo-google-organic-v1' | 'disabled';
  execute: (
    action: ExecutableResearchAction,
    context: GroundingToolContext,
  ) => Promise<ResearchToolResult>;
};

type SearchResult = Extract<ResearchToolResult, { kind: 'search' }>;

export type SearchSourcesAdapter = {
  provider: 'dataforseo-google-organic-v1';
  search: (query: string, signal: AbortSignal) => Promise<SearchResult>;
};

const genericSearchTerms = new Set(
  'official documentation docs release releases note notes changelog product version current classic legacy runtime architecture supported support compatibility npm typescript javascript build builds framework beta availability generally available launch announced announcement retirement retired shutdown sunset date pricing capabilities feature features deployment deploy migration microvm v8 isolate isolates linux when does is are was were can does not no and or the a an of for to with in on from by as at before after what how'.split(
    ' ',
  ),
);

const searchTerms = (text: string): string[] => {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
};

export const publicSearchVocabulary = (
  publicTerms: readonly string[],
): string[] => {
  return [
    ...new Set([...genericSearchTerms, ...publicTerms.flatMap(searchTerms)]),
  ];
};

/**
 * validatePublicSearchQuery lets only explicitly supplied public vocabulary
 * leave the job; prompts and answer text cannot become search queries.
 */
export const validatePublicSearchQuery = (
  query: string,
  publicTerms: readonly string[],
): void => {
  const allowed = new Set(publicSearchVocabulary(publicTerms));
  const words = searchTerms(query);

  if (
    words.length === 0 ||
    words.some((word) => !allowed.has(word)) ||
    /[@\n\r]|https?:|[a-f0-9]{32}/i.test(query)
  ) {
    throw new GroundingIntegrityError(
      'Search query contains terms outside approved public product vocabulary.',
    );
  }
};

type GroundingToolsOptions = {
  answers: readonly SavedAnswer[];
  publicSearchTerms: readonly string[];
  firstPartyHosts?: readonly string[];
  search?: SearchSourcesAdapter;
  searchProvider?: 'dataforseo-google-organic-v1' | 'disabled';
};

const invalidReference = {
  kind: 'failure',
  reason: 'invalid_reference',
  retryable: false,
} as const satisfies ResearchToolResult;

const fetchSource = async (
  action: Extract<ResearchAction, { tool: 'fetch_source' }>,
  {
    context,
    firstPartyHosts,
  }: {
    context: GroundingToolContext;
    firstPartyHosts: readonly string[] | undefined;
  },
): Promise<ResearchToolResult> => {
  const url = validateResearchUrl(action.url).href;

  // Refuse, do not abort. No request is made either way, so the boundary
  // holds identically; the model only has to drop a tracking parameter from
  // a URL it was shown for the old behaviour to discard every search and
  // fetch the session had already paid for.
  const isAllowed = context.allowedUrls
    .map((value) => validateResearchUrl(value).href)
    .includes(url);

  if (!isAllowed) {
    return invalidReference;
  }

  // The committed result holds the retained passage only; the whole text and
  // the byte count are the research reader's business.
  const fetched = await fetchGroundingSource({
    url,
    signal: context.signal,
    firstPartyHosts,
    beforeRequest: context.beforeFetchRequest,
  });

  const result = {
    kind: 'fetch',
    source: fetched.source,
    links: fetched.links,
    requestCount: fetched.requestCount,
  } as const;

  return result;
};

const readSavedEvidence = (
  action: Extract<ResearchAction, { tool: 'read_saved_evidence' }>,
  {
    answers,
    sources,
  }: {
    answers: readonly SavedAnswer[];
    sources: readonly GroundingSource[];
  },
): ResearchToolResult => {
  const answer = answers.find((item) => item.id === action.evidenceId);
  const source = sources.find((item) => item.id === action.evidenceId);

  let text: string;
  let fullDigest: string;

  if (answer) {
    text = answer.text;
    fullDigest = answer.digest;
  } else if (source) {
    text = source.passages.map((passage) => passage.text).join('\n');
    fullDigest = source.retainedDigest;
  } else {
    // Refuse, do not abort: the model chose this identifier, and a model
    // naming evidence outside its session is a mistake to correct on the
    // next decision, not a corrupt artifact. Retrying the same reference
    // cannot help, so the failure is not retryable.
    return invalidReference;
  }

  if (action.start >= text.length) {
    return invalidReference;
  }

  const result = {
    kind: 'read',
    evidenceId: action.evidenceId,
    text: text.slice(action.start, action.start + action.length),
    start: action.start,
    fullDigest,
    capturedAt: answer?.capturedAt ?? null,
  } as const;

  return result;
};

export const createGroundingTools = (
  args: GroundingToolsOptions,
): GroundingTools => {
  const searchProvider =
    args.searchProvider ?? args.search?.provider ?? 'disabled';

  if (args.search && args.search.provider !== searchProvider) {
    throw new GroundingIntegrityError(
      `Search adapter differs from the pinned provider: ${args.search.provider}.`,
    );
  }

  const searchSources = async (
    action: Extract<ResearchAction, { tool: 'search_sources' }>,
    signal: AbortSignal,
  ): Promise<ResearchToolResult> => {
    try {
      validatePublicSearchQuery(action.query, args.publicSearchTerms);
    } catch {
      // A query outside the public vocabulary is refused, not fatal.
      return { kind: 'failure', reason: 'invalid_query', retryable: false };
    }

    if (searchProvider === 'disabled' || !args.search) {
      return { kind: 'failure', reason: 'unavailable', retryable: false };
    }

    const result = researchToolResultSchema.parse(
      await args.search.search(action.query, signal),
    );

    return result;
  };

  return {
    searchProvider,
    execute: async (unchecked, context) => {
      const action = researchActionSchema.parse(unchecked);

      context.signal.throwIfAborted();

      switch (action.tool) {
        case 'finish_research': {
          throw new GroundingIntegrityError('Finish is not a tool.');
        }

        case 'search_sources': {
          return searchSources(action, context.signal);
        }

        case 'fetch_source': {
          return fetchSource(action, {
            context,
            firstPartyHosts: args.firstPartyHosts,
          });
        }

        case 'read_saved_evidence': {
          return readSavedEvidence(action, {
            answers: args.answers,
            sources: context.sources,
          });
        }

        default: {
          const unhandled: never = action;

          throw new Error(`Unhandled research tool: ${String(unhandled)}.`);
        }
      }
    },
  };
};

const dataForSeoResponseSchema = z.object({
  status_code: z.number(),
  cost: z.number().nonnegative().optional(),
  tasks: z.array(
    z.object({
      status_code: z.number(),
      id: z.string().optional(),
      result: z
        .array(
          z.object({
            items: z
              .array(
                z
                  .object({
                    type: z.string(),
                    url: z.string().optional(),
                    title: z.string().optional(),
                    description: z.string().nullable().optional(),
                  })
                  .passthrough(),
              )
              .nullable(),
          }),
        )
        .nullable(),
    }),
  ),
});

const maxSearchResponseBytes = 1_048_576;

const readBoundedBody = async (
  body: ReadableStream<Uint8Array>,
): Promise<Buffer> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    ) {
      size += chunk.value.length;

      if (size > maxSearchResponseBytes) {
        throw new Error(`Search provider response exceeds limit: ${size}.`);
      }

      chunks.push(chunk.value);
    }
  } finally {
    // Cancelling a finished or failed reader has nothing left to report.
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks);
};

/** How long a research tool call may take when it reads a page. */
const pageReadTimeoutMs = 15_000;

/** How long a search may take. It waits for DataForSEO's live scrape of
 * Google, which did not answer inside 15 seconds on any of the five
 * searches of a recorded author session (2026-11-11): the session wrote its
 * proposal from the pages it read alone. */
export const searchTimeoutMs = 60_000;

/** researchToolTimeoutOf is how long one research tool call may take: a
 * search waits for a live scrape, reading a page does not. */
export const researchToolTimeoutOf = (action: {
  tool: ResearchAction['tool'];
}): number => {
  return action.tool === 'search_sources' ? searchTimeoutMs : pageReadTimeoutMs;
};

/** createDataForSeoSearchAdapter builds an explicit, metered discovery adapter; returned snippets are never grounding sources. */
export const createDataForSeoSearchAdapter = (args: {
  login: string;
  password: string;
  locationCode: number;
  languageCode: string;
}): SearchSourcesAdapter => {
  if (
    !args.login ||
    !args.password ||
    !Number.isInteger(args.locationCode) ||
    !args.languageCode
  ) {
    throw new Error('Search credentials and locale are required.');
  }

  return {
    provider: 'dataforseo-google-organic-v1',
    search: async (query, signal) => {
      const boundedSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(searchTimeoutMs),
      ]);

      const response = await fetch(
        'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
        {
          method: 'POST',
          redirect: 'error',
          signal: boundedSignal,
          headers: {
            'authorization': `Basic ${Buffer.from(`${args.login}:${args.password}`).toString('base64')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify([
            {
              keyword: query,
              location_code: args.locationCode,
              language_code: args.languageCode,
              depth: 10,
            },
          ]),
        },
      );

      if (!response.ok || !response.body) {
        await response.body?.cancel();

        throw new Error(`Search provider unavailable: ${response.status}.`);
      }

      const body = await readBoundedBody(response.body);
      const data = dataForSeoResponseSchema.parse(
        JSON.parse(body.toString('utf8')),
      );

      if (
        data.status_code !== 20000 ||
        data.tasks.some((task) => task.status_code !== 20000)
      ) {
        throw new Error(`Search provider task failed: ${data.status_code}.`);
      }

      const leads: z.infer<typeof searchLeadSchema>[] = [];
      const items = data.tasks
        .flatMap((task) => task.result ?? [])
        .flatMap((result) => result.items ?? []);

      for (const item of items) {
        if (item.type !== 'organic' || !item.url || leads.length >= 10) {
          continue;
        }

        try {
          const url = validateResearchUrl(item.url).href;

          leads.push({
            id: `lead_${contentHash(url).slice(0, 24)}`,
            url,
            title: (item.title ?? '').slice(0, 500),
            snippet: (item.description ?? '').slice(0, 2000),
          });
        } catch {
          // Unsafe leads are never offered to the researcher.
        }
      }

      const result: SearchResult = {
        kind: 'search',
        leads,
        provider: 'dataforseo-google-organic-v1',
        reportedCostUsd: data.cost ?? null,
        providerRequestId: data.tasks[0]?.id,
      };

      return result;
    },
  };
};
