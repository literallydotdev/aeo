import { readFile } from 'node:fs/promises';
import { z } from 'zod';

// ============================================================================
// The gateway's public model list, as the price list of any model the engine
// has no entry of its own for (open models spec §3). A run reserves every
// paid call before it dispatches, so a model is usable exactly when an upper
// bound on its price can be read here; nothing else about it is judged.
//
// The list is a third party's document: only the fields below are read,
// unknown fields are dropped, and a price that is not a number makes the
// model unpriced. Reading it is free and needs no key.
// ============================================================================

export const gatewayCatalogUrl = 'https://ai-gateway.vercel.sh/v1/models';

const maxDocumentBytes = 4 * 1024 * 1024;
const readTimeoutMs = 15_000;

/** Thrown before any paid work when a model cannot be priced; the message
 * names the model and what to do. */
export class ModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCatalogError';
  }
}

/** Where a run's catalog documents come from: the gateway, or a saved copy. */
export type ModelCatalogSource = {
  origin: 'gateway' | 'file';
  /** The model list document. */
  list: () => Promise<string>;
  /** One listed model's per-provider endpoints document. */
  endpoints: (id: string) => Promise<string>;
};

export const catalogModelSchema = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    /** An upper bound on the list prices, USD per million tokens. */
    pricingUsdPerMillion: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cachedInput: z.number().nonnegative(),
      })
      .strict(),
    /** An upper bound on the provider's own search fee; null when the list
     * names none. */
    webSearchUsdPerRequest: z.number().nonnegative().nullable(),
    contextWindow: z.number().int().positive().nullable(),
    maxOutputTokens: z.number().int().positive().nullable(),
    reasoning: z.boolean(),
    reasoningEfforts: z.array(z.string().min(1).max(40)).max(20),
  })
  .strict();

/** A model as a run prices it. */
export type CatalogModel = z.infer<typeof catalogModelSchema>;

// Prices are decimal strings, USD per token.
const priceSchema = z.string().max(40);
const tiersSchema = z.array(z.object({ cost: priceSchema })).max(50);

const listPricesSchema = z.object({
  input: priceSchema.nullish(),
  output: priceSchema.nullish(),
  input_cache_read: priceSchema.nullish(),
  input_tiers: tiersSchema.nullish(),
  output_tiers: tiersSchema.nullish(),
  input_cache_read_tiers: tiersSchema.nullish(),
});

const listEntrySchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200).nullish(),
  type: z.string().min(1).max(40),
  context_window: z.number().int().positive().nullish(),
  max_tokens: z.number().int().positive().nullish(),
  tags: z.array(z.string().max(60)).max(100).nullish(),
  reasoning_options: z
    .array(
      z.object({
        type: z.string().max(40),
        values: z.array(z.string().min(1).max(40)).max(20).nullish(),
      }),
    )
    .max(10)
    .nullish(),
  pricing: listPricesSchema
    .extend({
      regional: z.record(z.string().max(40), listPricesSchema).nullish(),
      varies_by_provider: z.boolean().nullish(),
      peak_pricing: z
        .object({ multiplier: z.number().positive().max(100) })
        .nullish(),
      /** USD per 1,000 requests. */
      web_search: priceSchema.nullish(),
    })
    .nullish(),
});

const endpointPricesSchema = z.object({
  prompt: priceSchema.nullish(),
  completion: priceSchema.nullish(),
  input_cache_read: priceSchema.nullish(),
  prompt_tiers: tiersSchema.nullish(),
  completion_tiers: tiersSchema.nullish(),
  input_cache_read_tiers: tiersSchema.nullish(),
});

const endpointsDocumentSchema = z.object({
  data: z.object({
    endpoints: z
      .array(
        z.object({
          pricing: endpointPricesSchema.extend({
            /** USD per request. */
            web_search: priceSchema.nullish(),
          }),
          inference_regions: z
            .array(z.object({ pricing: endpointPricesSchema.nullish() }))
            .max(100)
            .nullish(),
        }),
      )
      .min(1)
      .max(100),
  }),
});

const listDocumentSchema = z.object({ data: z.array(z.unknown()).max(10_000) });
const listedIdSchema = z.object({ id: z.string() });

/** Every price listed for one token kind, across a model's price tables. */
type ListedPrices = {
  input: string[];
  output: string[];
  cachedInput: string[];
  /** USD per request. */
  webSearch: number[];
};

const tierCosts = (tiers: z.infer<typeof tiersSchema> | null | undefined) => {
  return (tiers ?? []).map((tier) => tier.cost);
};

const listed = (...prices: Array<string | null | undefined>): string[] => {
  return prices.filter((price) => price !== null && price !== undefined);
};

const unpriced = (id: string, why: string): ModelCatalogError => {
  return new ModelCatalogError(
    `${id} has no usable price on the gateway's model list (${why}). A run reserves every call at a known price before it spends, so it cannot use this model.`,
  );
};

const usdOf = (id: string, price: string): number => {
  const value = price.trim() === '' ? Number.NaN : Number(price);

  if (!Number.isFinite(value) || value < 0) {
    throw unpriced(id, `"${price.slice(0, 40)}" is not a price`);
  }

  return value;
};

/** The highest of the listed per-token prices, in USD per million tokens. */
const highestPerMillion = (
  id: string,
  prices: readonly string[],
  multiplier: number,
): number | undefined => {
  if (prices.length === 0) {
    return undefined;
  }

  const highest = Math.max(...prices.map((price) => usdOf(id, price)));

  // To a millionth of a dollar: per-token decimals pick up binary noise
  // once multiplied (0.0000001 × 1e6 is 0.09999999999999999).
  return Math.round(highest * multiplier * 1e12) / 1e6;
};

const collectListPrices = (
  prices: z.infer<typeof listPricesSchema>,
  into: ListedPrices,
) => {
  into.input.push(...listed(prices.input), ...tierCosts(prices.input_tiers));
  into.output.push(...listed(prices.output), ...tierCosts(prices.output_tiers));
  into.cachedInput.push(
    ...listed(prices.input_cache_read),
    ...tierCosts(prices.input_cache_read_tiers),
  );
};

const collectEndpointPrices = (
  prices: z.infer<typeof endpointPricesSchema>,
  into: ListedPrices,
) => {
  into.input.push(...listed(prices.prompt), ...tierCosts(prices.prompt_tiers));
  into.output.push(
    ...listed(prices.completion),
    ...tierCosts(prices.completion_tiers),
  );
  into.cachedInput.push(
    ...listed(prices.input_cache_read),
    ...tierCosts(prices.input_cache_read_tiers),
  );
};

const parseJson = (text: string, what: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);

    return value;
  } catch (error) {
    throw new ModelCatalogError(
      `${what} is not JSON (${error instanceof Error ? error.message.slice(0, 120) : String(error)}).`,
    );
  }
};

const collectProviderPrices = async (
  id: string,
  source: ModelCatalogSource,
  into: ListedPrices,
) => {
  const parsed = endpointsDocumentSchema.safeParse(
    parseJson(await source.endpoints(id), `The gateway's endpoints for ${id}`),
  );

  if (!parsed.success) {
    throw unpriced(
      id,
      'its price varies by provider, and its per-provider prices could not be read',
    );
  }

  for (const endpoint of parsed.data.data.endpoints) {
    collectEndpointPrices(endpoint.pricing, into);

    for (const region of endpoint.inference_regions ?? []) {
      if (region.pricing) {
        collectEndpointPrices(region.pricing, into);
      }
    }

    if (endpoint.pricing.web_search) {
      into.webSearch.push(usdOf(id, endpoint.pricing.web_search));
    }
  }
};

/**
 * One listed model with the upper bound of its prices: the highest price it
 * lists for each token kind across its base price, every tier and every
 * region, times its peak multiplier, and, when its price varies by provider,
 * across every provider's endpoint. Prices of a service tier or a fast mode
 * are left out: the engine never requests one.
 */
const catalogModelOf = async (
  entry: z.infer<typeof listEntrySchema>,
  source: ModelCatalogSource,
): Promise<CatalogModel> => {
  const { id, pricing } = entry;

  if (entry.type !== 'language') {
    throw new ModelCatalogError(
      `${id} is listed with the type "${entry.type}" on the gateway's model list, not as a language model. Please name a language model.`,
    );
  }

  if (!pricing) {
    throw unpriced(id, 'it lists no prices');
  }

  const prices: ListedPrices = {
    input: [],
    output: [],
    cachedInput: [],
    webSearch: [],
  };

  collectListPrices(pricing, prices);

  for (const regional of Object.values(pricing.regional ?? {})) {
    collectListPrices(regional, prices);
  }

  if (pricing.web_search) {
    prices.webSearch.push(usdOf(id, pricing.web_search) / 1000);
  }

  if (pricing.varies_by_provider) {
    await collectProviderPrices(id, source, prices);
  }

  // A multiplier under one is a discount, which an upper bound ignores.
  const multiplier = Math.max(1, pricing.peak_pricing?.multiplier ?? 1);
  const input = highestPerMillion(id, prices.input, multiplier);
  const output = highestPerMillion(id, prices.output, multiplier);

  if (input === undefined || output === undefined) {
    throw unpriced(id, 'it lists no input or no output price');
  }

  return {
    id,
    label: entry.name ?? id,
    pricingUsdPerMillion: {
      input,
      output,
      // Without a listed cache-read price, a cached token is bounded by
      // an uncached one.
      cachedInput:
        highestPerMillion(id, prices.cachedInput, multiplier) ?? input,
    },
    webSearchUsdPerRequest:
      prices.webSearch.length === 0 ? null : Math.max(...prices.webSearch),
    contextWindow: entry.context_window ?? null,
    maxOutputTokens: entry.max_tokens ?? null,
    reasoning: (entry.tags ?? []).includes('reasoning'),
    reasoningEfforts: (entry.reasoning_options ?? [])
      .filter((option) => option.type === 'effort')
      .flatMap((option) => option.values ?? []),
  };
};

/**
 * readCatalogModels prices each named model from the catalog, in order, and
 * refuses the first it cannot: one that is not listed, is not a language
 * model, or has no upper bound on its price.
 */
export const readCatalogModels = async (
  ids: readonly string[],
  source: ModelCatalogSource,
): Promise<CatalogModel[]> => {
  const list = listDocumentSchema.safeParse(
    parseJson(await source.list(), "The gateway's model list"),
  );

  if (!list.success) {
    throw new ModelCatalogError(
      "The gateway's model list does not have the shape this release reads (an object with a `data` array). Please check AEO_MODEL_CATALOG if it is set, or upgrade literally-aeo.",
    );
  }

  const models: CatalogModel[] = [];

  for (const id of ids) {
    const listedEntry = list.data.data.find((entry) => {
      const named = listedIdSchema.safeParse(entry);

      return named.success && named.data.id === id;
    });

    if (listedEntry === undefined) {
      throw new ModelCatalogError(
        `${id} is not on the gateway's model list (${gatewayCatalogUrl}). Please check the model ID; a run prices every model before it spends.`,
      );
    }

    const entry = listEntrySchema.safeParse(listedEntry);

    if (!entry.success) {
      throw unpriced(
        id,
        'its entry does not have the shape this release reads',
      );
    }

    models.push(await catalogModelOf(entry.data, source));
  }

  return models;
};

const unreachable = (what: string, reason: string): ModelCatalogError => {
  return new ModelCatalogError(
    `${what} could not be read (${reason}). A model outside the engine's own list is priced from it before a run spends. Please check the network, or set AEO_MODEL_CATALOG to a saved copy of ${gatewayCatalogUrl}.`,
  );
};

/** Reads a response body as text, refusing one past the size bound. */
const boundedText = async (response: Response, what: string) => {
  const reader = response.body?.getReader();

  if (!reader) {
    throw unreachable(what, 'the response has no body');
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;
    if (size > maxDocumentBytes) {
      await reader.cancel();

      throw unreachable(what, `it is larger than ${maxDocumentBytes} bytes`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
};

/**
 * gatewayCatalogSource reads the catalog from the gateway: free, without a
 * key, bounded in time and size, and never following a redirect.
 */
export const gatewayCatalogSource = ({
  fetch,
  signal,
}: {
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}): ModelCatalogSource => {
  const read = async (url: string, what: string): Promise<string> => {
    const timeout = AbortSignal.timeout(readTimeoutMs);
    let response: Response;

    try {
      response = await fetch(url, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw unreachable(
        what,
        error instanceof Error ? error.message.slice(0, 200) : String(error),
      );
    }

    if (!response.ok) {
      throw unreachable(what, `the gateway answered ${response.status}`);
    }

    return boundedText(response, what);
  };

  return {
    origin: 'gateway',
    list: () => read(gatewayCatalogUrl, "The gateway's model list"),
    // Only for an ID the list itself named; each segment is still encoded,
    // so an ID can never address another path.
    endpoints: (id) =>
      read(
        `${gatewayCatalogUrl}/${id.split('/').map(encodeURIComponent).join('/')}/endpoints`,
        `The gateway's endpoints for ${id}`,
      ),
  };
};

/**
 * fileCatalogSource reads a saved copy of the model list (AEO_MODEL_CATALOG),
 * for a run without network access to the gateway. A saved list holds no
 * per-provider prices, so a model whose price varies by provider cannot be
 * priced from it.
 */
export const fileCatalogSource = (file: string): ModelCatalogSource => {
  return {
    origin: 'file',
    list: async () => {
      let content: Buffer;

      try {
        content = await readFile(file);
      } catch (error) {
        throw new ModelCatalogError(
          `AEO_MODEL_CATALOG names ${file}, which could not be read (${error instanceof Error ? error.message.slice(0, 200) : String(error)}). Please save a copy of ${gatewayCatalogUrl} there, or unset it.`,
        );
      }

      if (content.byteLength > maxDocumentBytes) {
        throw new ModelCatalogError(
          `AEO_MODEL_CATALOG names ${file}, which is larger than ${maxDocumentBytes} bytes; a model list is not. Please save a copy of ${gatewayCatalogUrl} there.`,
        );
      }

      return content.toString('utf8');
    },
    endpoints: (id) =>
      Promise.reject(
        new ModelCatalogError(
          `${id} has a price that varies by provider, and the saved model list (AEO_MODEL_CATALOG) holds no per-provider prices. Please unset AEO_MODEL_CATALOG to price it from the gateway.`,
        ),
      ),
  };
};
