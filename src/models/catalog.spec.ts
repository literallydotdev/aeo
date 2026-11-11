import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fileCatalogSource,
  gatewayCatalogSource,
  gatewayCatalogUrl,
  ModelCatalogError,
  readCatalogModels,
  type ModelCatalogSource,
} from './catalog';

// The fixtures are the gateway's own documents, captured on 2026-11-10:
// eight entries of its model list, and one model's endpoints.
const fixture = (name: string) => {
  return readFile(path.join(import.meta.dirname, '__fixtures__', name), 'utf8');
};

const captured: ModelCatalogSource = {
  origin: 'gateway',
  list: () => fixture('gateway-models.json'),
  endpoints: () => fixture('gateway-endpoints.json'),
};

/** A list of the given entries, with no per-provider prices to read. */
const listOf = (...entries: unknown[]): ModelCatalogSource => {
  return {
    origin: 'gateway',
    list: () => Promise.resolve(JSON.stringify({ data: entries })),
    endpoints: () => Promise.reject(new Error('No endpoints were expected.')),
  };
};

const language = (pricing: unknown) => {
  return { id: 'acme/model', type: 'language', pricing };
};

describe('catalog - readCatalogModels()', () => {
  it('should price a model at the highest price it lists across its tiers and regions', async () => {
    const [luna, sonnet, flashLite] = await readCatalogModels(
      [
        'openai/gpt-6-luna',
        'anthropic/claude-sonnet-5',
        'google/gemini-3.5-flash-lite',
      ],
      captured,
    );

    // GPT-6 Luna lists $0.10 in and $0.50 out per million; its long-prompt
    // tier $0.20 and $0.75, and its regions a tenth more.
    expect(luna).toEqual({
      id: 'openai/gpt-6-luna',
      label: 'GPT-6 Luna',
      pricingUsdPerMillion: { input: 0.22, output: 0.825, cachedInput: 0.022 },
      // "10" per 1,000 requests.
      webSearchUsdPerRequest: 0.01,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
    // $2 and $10 at base, $2.20 and $11 in every region.
    expect(sonnet?.pricingUsdPerMillion).toEqual({
      input: 2.2,
      output: 11,
      cachedInput: 0.22,
    });
    // Its dearer "priority" service tier is left out: nothing requests it.
    expect(flashLite).toMatchObject({
      pricingUsdPerMillion: { input: 0.33, output: 2.75, cachedInput: 0.033 },
      webSearchUsdPerRequest: 0.014,
      reasoningEfforts: ['low', 'high'],
    });
  });

  it('should bound a tiered model by its dearest tier, and a cached token by an uncached one when no cache price is listed', async () => {
    const [tiered, sonar] = await readCatalogModels(
      ['alibaba/qwen3-max-thinking', 'perplexity/sonar'],
      captured,
    );

    // $1.20 and $6 up to 32k tokens, $3 and $15 past 128k.
    expect(tiered).toMatchObject({
      pricingUsdPerMillion: { input: 3, output: 15, cachedInput: 0.6 },
      webSearchUsdPerRequest: null,
      // Its reasoning is a token budget, not an effort.
      reasoningEfforts: [],
    });
    expect(sonar).toMatchObject({
      pricingUsdPerMillion: { input: 0.25, output: 2.5, cachedInput: 0.25 },
      webSearchUsdPerRequest: 0.0025,
    });
  });

  it('should price a free model at zero', async () => {
    const [free] = await readCatalogModels(['reflection/beam-free'], captured);

    expect(free?.pricingUsdPerMillion).toEqual({
      input: 0,
      output: 0,
      cachedInput: 0,
    });
  });

  it("should take the dearest provider's price, regions included, when the price varies by provider", async () => {
    const source: ModelCatalogSource = {
      ...listOf(
        language({
          input: '0.000001',
          output: '0.000002',
          varies_by_provider: true,
        }),
      ),
      endpoints: captured.endpoints,
    };

    const [model] = await readCatalogModels(['acme/model'], source);

    // The captured endpoints list $2 and $10, and $2.20 and $11 in a region.
    expect(model).toMatchObject({
      pricingUsdPerMillion: { input: 2.2, output: 11, cachedInput: 0.22 },
      webSearchUsdPerRequest: 0.01,
    });
  });

  it('should refuse a model whose price varies by provider when the per-provider prices cannot be read', async () => {
    const entry = language({
      input: '0.000001',
      output: '0.000002',
      varies_by_provider: true,
    });
    const unreadable: ModelCatalogSource = {
      ...listOf(entry),
      endpoints: () => Promise.resolve('{"data":{"endpoints":[]}}'),
    };

    await expect(readCatalogModels(['acme/model'], unreadable)).rejects.toThrow(
      /acme\/model has no usable price .*per-provider prices could not be read/,
    );
  });

  it('should multiply by a peak multiplier, and ignore one that is a discount', async () => {
    const prices = { input: '0.000001', output: '0.000002' };

    const [peak] = await readCatalogModels(
      ['acme/model'],
      listOf(language({ ...prices, peak_pricing: { multiplier: 2 } })),
    );
    const [offPeak] = await readCatalogModels(
      ['acme/model'],
      listOf(language({ ...prices, peak_pricing: { multiplier: 0.5 } })),
    );

    expect(peak?.pricingUsdPerMillion).toEqual({
      input: 2,
      output: 4,
      cachedInput: 2,
    });
    expect(offPeak?.pricingUsdPerMillion).toMatchObject({
      input: 1,
      output: 2,
    });
  });

  it('should refuse a model that is not listed, is not a language model, or has no price', async () => {
    const refusal = (id: string, source: ModelCatalogSource) => {
      return readCatalogModels([id], source).catch((error: unknown) => error);
    };

    const unlisted = await refusal('nope/nothing', captured);
    const embedding = await refusal('alibaba/qwen3-embedding-0.6b', captured);
    const noOutput = await refusal(
      'acme/model',
      listOf(language({ input: '0.000001' })),
    );
    const notAPrice = await refusal(
      'acme/model',
      listOf(language({ input: 'call us', output: '0.000002' })),
    );
    const negative = await refusal(
      'acme/model',
      listOf(language({ input: '-0.000001', output: '0.000002' })),
    );

    for (const error of [unlisted, embedding, noOutput, notAPrice, negative]) {
      expect(error).toBeInstanceOf(ModelCatalogError);
    }
    expect(String(unlisted)).toContain('nope/nothing is not on the gateway');
    expect(String(embedding)).toContain('the type "embedding"');
    expect(String(noOutput)).toContain('no input or no output price');
    expect(String(notAPrice)).toContain('"call us" is not a price');
    expect(String(negative)).toContain('"-0.000001" is not a price');
  });

  it('should refuse a document that is not a model list, without reading further', async () => {
    const notJson: ModelCatalogSource = {
      ...listOf(),
      list: () => Promise.resolve('<html>Sign in</html>'),
    };
    const otherShape: ModelCatalogSource = {
      ...listOf(),
      list: () => Promise.resolve('{"models":[]}'),
    };

    await expect(readCatalogModels(['acme/model'], notJson)).rejects.toThrow(
      /The gateway's model list is not JSON/,
    );
    await expect(readCatalogModels(['acme/model'], otherShape)).rejects.toThrow(
      /does not have the shape this release reads/,
    );
  });
});

describe('catalog - gatewayCatalogSource()', () => {
  it('should read the list and the endpoints of an ID without following redirects, encoding the ID into the path', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('{"data":[]}')),
    );
    const source = gatewayCatalogSource({ fetch });

    expect(await source.list()).toBe('{"data":[]}');
    await source.endpoints('acme/model v2?x=1');

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      gatewayCatalogUrl,
      `${gatewayCatalogUrl}/acme/model%20v2%3Fx%3D1/endpoints`,
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      accept: 'application/json',
    });
  });

  it('should refuse a failed, unreachable or oversized response, and say how to run from a saved copy', async () => {
    const reading = (fetch: typeof globalThis.fetch) => {
      return gatewayCatalogSource({ fetch }).list();
    };

    await expect(
      reading(() => Promise.resolve(new Response('nope', { status: 503 }))),
    ).rejects.toThrow(/the gateway answered 503.*AEO_MODEL_CATALOG/);
    await expect(
      reading(() => Promise.reject(new TypeError('fetch failed'))),
    ).rejects.toThrow(/fetch failed.*AEO_MODEL_CATALOG/);
    await expect(
      reading(() =>
        Promise.resolve(new Response(new Uint8Array(4 * 1024 * 1024 + 1))),
      ),
    ).rejects.toThrow(/larger than 4194304 bytes/);
  });
});

describe('catalog - fileCatalogSource()', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aeo-catalog-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('should price a model from a saved copy of the list', async () => {
    const file = path.join(dir, 'models.json');

    await writeFile(file, await fixture('gateway-models.json'));

    const [sonar] = await readCatalogModels(
      ['perplexity/sonar'],
      fileCatalogSource(file),
    );

    expect(sonar?.pricingUsdPerMillion.output).toBe(2.5);
  });

  it('should refuse a missing file, and a model whose price varies by provider', async () => {
    const file = path.join(dir, 'models.json');

    await expect(
      readCatalogModels(['perplexity/sonar'], fileCatalogSource(file)),
    ).rejects.toThrow(/AEO_MODEL_CATALOG names .* could not be read/);

    await writeFile(
      file,
      JSON.stringify({
        data: [
          language({
            input: '0.000001',
            output: '0.000002',
            varies_by_provider: true,
          }),
        ],
      }),
    );

    await expect(
      readCatalogModels(['acme/model'], fileCatalogSource(file)),
    ).rejects.toThrow(/holds no per-provider prices/);
  });
});
