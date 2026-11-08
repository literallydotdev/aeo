import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { fetchGroundingSource } from '../grounding/fetch';
import { extractSourceDocument } from '../grounding/fetch';
import { SourceRetrievalError } from '../grounding/guarded-request';
import { syntheticExample } from '../author/examples';
import type { AuthorSearchAdapter } from './author-search';
import {
  createAuthorTools,
  parseRobots,
  readResearchDocuments,
  readResearchJournal,
  robotsAllows,
  summarizeResearch,
  type AuthorToolsOptions,
} from './author-tools';

// ============================================================================
// The research tools against an in-memory web (specs/aeo-codex-author-spec
// §9): every cap and its refusal, the per-host spacing, URL safety, the
// secret scrub, the RESEARCH/ cache, robots.txt, and submit.
// ============================================================================

const secret = 'sk-test-secret-value-1234567890';

const pages: Record<string, string> = {
  'https://example.com/':
    '<html><head><title>Example</title></head><body><main><h1>Example Tools</h1><p>Database change review for teams.</p><a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/private">Private</a></main></body></html>',
  'https://example.com/docs':
    '<html><head><title>Docs</title></head><body><main><p>Example connects to Postgres and MySQL.</p></main></body></html>',
  'https://example.com/pricing':
    '<html><head><title>Pricing</title></head><body><main><p>Free tier available.</p></main></body></html>',
  'https://example.com/private':
    '<html><head><title>Private</title></head><body><main><p>Internal.</p></main></body></html>',
  'https://example.com/robots.txt':
    'User-agent: *\nDisallow: /private\n\nUser-agent: Literally-AEO-Research\nDisallow: /pricing\n',
  'https://other.example.org/':
    '<html><head><title>Other</title></head><body><main><p>Sample One reviews schemas.</p></main></body></html>',
};

const fakeFetch = (calls: string[]): typeof fetchGroundingSource => {
  return async ({ url, beforeRequest }) => {
    calls.push(url);
    await beforeRequest?.();

    const body = pages[url];

    if (body === undefined) {
      throw new SourceRetrievalError('http_error', 'Source HTTP 404', {
        status: 404,
      });
    }

    const fetchedAt = '2026-09-15T10:00:00.000Z';

    if (url.endsWith('/robots.txt')) {
      return {
        ...extractSourceDocument({
          requestedUrl: url,
          finalUrl: url,
          body,
          contentType: 'text/plain',
          fetchedAt,
        }),
        requestCount: 1,
        bytes: Buffer.byteLength(body),
      };
    }

    return {
      ...extractSourceDocument({
        requestedUrl: url,
        finalUrl: url,
        body,
        contentType: 'text/html',
        fetchedAt,
      }),
      requestCount: 1,
      bytes: Buffer.byteLength(body),
    };
  };
};

const fakeSearch = (costUsd: number | null = 0.01): AuthorSearchAdapter => {
  const hit = {
    url: 'https://other.example.org/',
    title: 'Other',
    publishedDate: null,
    text: 'Sample One reviews schemas.',
  };

  return {
    provider: 'dataforseo-google-organic-v1',
    search: () =>
      Promise.resolve({
        provider: 'dataforseo-google-organic-v1' as const,
        results: [hit],
        costUsd,
      }),
  };
};

const tools = async (
  overrides: Partial<AuthorToolsOptions> = {},
  calls: string[] = [],
) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aeo-author-tools-'));
  let clock = 1_000_000;
  const waits: number[] = [];
  const created = createAuthorTools({
    dir,
    label: 'author-0',
    secrets: [secret],
    search: fakeSearch(),
    fetchSource: fakeFetch(calls),
    now: () => clock,
    sleep: (ms) => {
      waits.push(ms);
      clock += ms;

      return Promise.resolve();
    },
    ...overrides,
  });

  return {
    dir,
    tools: created,
    calls,
    waits,
    tick: (ms: number) => (clock += ms),
  };
};

const payload = (result: { content: { text: string }[] }) => {
  const [content] = result.content;

  if (!content) {
    throw new Error('Expected the tool result to carry content.');
  }

  return JSON.parse(content.text) as Record<string, unknown>;
};

describe('AuthorTools - call() with fetch', () => {
  it('should save the page under RESEARCH/, return its text and links, and serve a repeat from the saved copy', async () => {
    const { dir, tools: t, calls } = await tools();
    const first = payload(
      await t.call('fetch', { url: 'https://example.com/' }),
    );

    expect(first.path).toBe('RESEARCH/1.md');
    expect(first.text).toContain('Database change review');
    expect(first.links).toEqual([
      'https://example.com/docs',
      'https://example.com/pricing',
      'https://example.com/private',
    ]);
    expect(first.cached).toBe(false);

    const again = payload(
      await t.call('fetch', { url: 'https://example.com/#top' }),
    );

    expect(again.cached).toBe(true);
    expect(again.path).toBe('RESEARCH/1.md');
    // robots.txt once, the page once.
    expect(calls).toEqual([
      'https://example.com/robots.txt',
      'https://example.com/',
    ]);

    const saved = await readFile(path.join(dir, 'RESEARCH/1.md'), 'utf8');

    expect(saved).toContain('- url: https://example.com/');
    expect(saved).toContain('<untrusted-web-content>');

    const documents = await readResearchDocuments(dir);

    expect(documents).toHaveLength(1);
    expect(documents[0]?.source?.finalUrl).toBe('https://example.com/');

    const journal = await readResearchJournal(dir, 'author-0');

    expect(
      journal.map((entry) => [entry.tool, entry.outcome, entry.cached]),
    ).toEqual([
      ['fetch', 'ok', undefined],
      ['fetch', 'ok', true],
    ]);
    expect(journal[0]?.bytes).toBeGreaterThan(0);
  });

  it('should space requests to one host by the interval and never sleep for another', async () => {
    const { tools: t, waits } = await tools();

    await t.call('fetch', { url: 'https://example.com/' });
    await t.call('fetch', { url: 'https://example.com/docs' });
    await t.call('fetch', { url: 'https://other.example.org/' });
    // robots then the page on example.com, then docs: two waits of a
    // second each; other.example.org's robots is its first request.
    expect(waits).toEqual([1000, 1000, 1000]);
  });

  it('should refuse the session cap, the per-host cap and the byte cap with a structured refusal', async () => {
    const { tools: t, calls } = await tools({ caps: { fetch: 2 } });

    await t.call('fetch', { url: 'https://example.com/' });
    await t.call('fetch', { url: 'https://example.com/docs' });

    const refused = payload(
      await t.call('fetch', { url: 'https://other.example.org/' }),
    );

    expect(refused.refused).toEqual({ cap: 'fetch', limit: 2 });
    expect(refused.advice).toContain('Finish with what you have');
    expect(calls).not.toContain('https://other.example.org/');

    const perHost = await tools({ caps: { fetchPerHost: 1 } });

    await perHost.tools.call('fetch', { url: 'https://example.com/' });
    expect(
      payload(
        await perHost.tools.call('fetch', { url: 'https://example.com/docs' }),
      ).refused,
    ).toMatchObject({ cap: 'fetch_per_host', host: 'example.com' });

    const bytes = await tools({ caps: { fetchedBytes: 10 } });

    await bytes.tools.call('fetch', { url: 'https://example.com/' });
    expect(
      payload(
        await bytes.tools.call('fetch', { url: 'https://other.example.org/' }),
      ).refused,
    ).toMatchObject({ cap: 'fetched_bytes' });

    const journal = await readResearchJournal(bytes.dir, 'author-0');

    expect(journal.at(-1)).toMatchObject({
      outcome: 'refused',
      reason: 'cap:fetched_bytes',
    });
  });

  it('should refuse unsafe destinations without a request and report a missing page', async () => {
    const { tools: t, calls } = await tools();

    for (const url of [
      'http://example.com/',
      'https://localhost/',
      'https://10.0.0.1/',
      'not a url',
    ]) {
      const result = await t.call('fetch', { url });

      expect(result.isError).toBe(true);
      expect(payload(result).error).toBe('unsafe_destination');
    }

    expect(calls).toEqual([]);

    const missing = await t.call('fetch', { url: 'https://example.com/nope' });

    expect(payload(missing)).toMatchObject({
      error: 'http_error',
      status: 404,
    });
    expect(t.state().calls.fetch).toBe(1);
  });

  it("should respect robots.txt for the research agent's own group before the wildcard", async () => {
    const { tools: t, calls } = await tools();
    const pricing = await t.call('fetch', {
      url: 'https://example.com/pricing',
    });

    expect(payload(pricing).error).toBe('robots_disallowed');

    // The wildcard group's /private rule does not apply once the agent has
    // its own group.
    const priv = payload(
      await t.call('fetch', { url: 'https://example.com/private' }),
    );

    expect(priv.path).toBe('RESEARCH/1.md');
    expect(calls.filter((url) => url.endsWith('robots.txt'))).toHaveLength(1);
  });

  it('should refuse an argument carrying a credential and scrub the journal', async () => {
    const { dir, tools: t, calls } = await tools();
    const result = await t.call('fetch', {
      url: `https://example.com/?key=${secret}`,
    });

    expect(result.isError).toBe(true);
    expect(payload(result).error).toBe('secret_in_argument');
    expect(calls).toEqual([]);

    const raw = await readFile(
      path.join(dir, 'JOURNAL/author-0.research.jsonl'),
      'utf8',
    );

    expect(raw).not.toContain(secret);

    const search = await t.call('search', {
      query: `what is ${secret}`,
      purpose: 'x',
    });

    expect(payload(search).error).toBe('secret_in_argument');
  });
});

describe('AuthorTools - call() with render', () => {
  it('should use the renderer, save the rendered page and count its own cap', async () => {
    const { dir, tools: t } = await tools({
      caps: { render: 1 },
      renderHtml: (url) =>
        Promise.resolve(
          `<html><head><title>Rendered</title></head><body><main><p>Rendered ${url.pathname}</p></main></body></html>`,
        ),
    });

    const rendered = payload(
      await t.call('render', { url: 'https://example.com/app' }),
    );

    expect(rendered.text).toContain('Rendered /app');
    expect(rendered.path).toBe('RESEARCH/1.md');
    expect(
      payload(await t.call('render', { url: 'https://example.com/other' }))
        .refused,
    ).toEqual({ cap: 'render', limit: 1 });
    // A fetch of a rendered URL returns the saved copy.
    expect(
      payload(await t.call('fetch', { url: 'https://example.com/app' })).cached,
    ).toBe(true);

    const documents = await readResearchDocuments(dir);

    expect(documents[0]?.header.kind).toBe('render');
  });

  it('should report a missing renderer as an error, not a crash', async () => {
    const { tools: t } = await tools();
    const result = await t.call('render', { url: 'https://example.com/' });

    expect(result.isError).toBe(true);
    expect(payload(result).error).toBe('retrieval_failed');
  });
});

describe('AuthorTools - call() with search', () => {
  it('should return the provider results, meter the spend and journal the query', async () => {
    const { dir, tools: t } = await tools();
    const result = payload(
      await t.call('search', {
        query: 'schema review tools',
        purpose: 'market',
      }),
    );

    expect(result.provider).toBe('dataforseo-google-organic-v1');
    expect((result.results as unknown[]).length).toBe(1);

    const summary = summarizeResearch(
      await readResearchJournal(dir, 'author-0'),
    );

    expect(summary).toMatchObject({
      searches: 1,
      spendUsd: 0.01,
      searchQueries: ['schema review tools'],
    });
  });

  it('should refuse over the call caps and the spend cap', async () => {
    const { tools: t } = await tools({ caps: { search: 1 } });

    await t.call('search', { query: 'a', purpose: 'b' });
    expect(
      payload(await t.call('search', { query: 'a', purpose: 'b' })).refused,
    ).toEqual({ cap: 'search', limit: 1 });

    const spend = await tools({
      caps: { searchSpendUsd: 0.015 },
      search: fakeSearch(0.01),
    });

    await spend.tools.call('search', { query: 'a', purpose: 'b' });
    await spend.tools.call('search', { query: 'a', purpose: 'b' });
    expect(
      payload(await spend.tools.call('search', { query: 'a', purpose: 'b' }))
        .refused,
    ).toEqual({ cap: 'search_spend', limitUsd: 0.015 });
  });

  it('should tell the session when there is no provider', async () => {
    const none = await tools({ search: null });

    expect(
      payload(await none.tools.call('search', { query: 'a', purpose: 'b' })),
    ).toMatchObject({ error: 'unavailable' });
  });

  it('should journal a provider failure and keep the session going', async () => {
    const failing: AuthorSearchAdapter = {
      provider: 'dataforseo-google-organic-v1',
      search: () => Promise.reject(new Error('Search provider HTTP 503')),
    };
    const { dir, tools: t } = await tools({ search: failing });
    const result = payload(
      await t.call('search', { query: 'a', purpose: 'b' }),
    );

    expect(result.error).toBe('provider_error');
    expect((await readResearchJournal(dir, 'author-0')).at(-1)).toMatchObject({
      tool: 'search',
      outcome: 'error',
      reason: 'provider_error',
    });
  });
});

describe('AuthorTools - call() with submit', () => {
  const notes = {
    verdict: 'fit',
    confidence: 0.9,
    reasons: ['RESEARCH/1.md shows the product'],
    briefContradiction: false,
    proposedFacts: [],
  };

  it('should write the output only when both objects fit the schema, replacing it on every call', async () => {
    const { dir, tools: t } = await tools();
    const bad = payload(
      await t.call('submit', { config: { brand: {} }, notes }),
    );

    expect(bad.ok).toBe(false);
    expect((bad.errors as string[]).some((e) => e.startsWith('config.'))).toBe(
      true,
    );
    await expect(stat(path.join(dir, 'OUT/author/0.json'))).rejects.toThrow();

    const good = payload(
      await t.call('submit', { config: syntheticExample, notes }),
    );

    expect(good).toEqual({ ok: true, path: 'OUT/author/0.json' });

    const written: unknown = JSON.parse(
      await readFile(path.join(dir, 'OUT/author/0.json'), 'utf8'),
    );

    expect(written).toHaveProperty(
      ['config', 'brand', 'name'],
      'Example Tools',
    );
    expect(written).toHaveProperty(['notes', 'verdict'], 'fit');
    await t.call('submit', {
      config: { ...syntheticExample, productBrief: 'Changed' },
      notes,
    });
    expect(
      JSON.parse(await readFile(path.join(dir, 'OUT/author/0.json'), 'utf8')),
    ).toHaveProperty(['config', 'productBrief'], 'Changed');
    expect(await readdir(path.join(dir, 'OUT/author'))).toEqual(['0.json']);
  });

  it('should accept config and notes that arrive as JSON strings and write them as objects', async () => {
    const { dir, tools: t } = await tools();

    const result = payload(
      await t.call('submit', {
        config: JSON.stringify(syntheticExample),
        notes: JSON.stringify(notes),
      }),
    );

    expect(result).toEqual({ ok: true, path: 'OUT/author/0.json' });

    const written: unknown = JSON.parse(
      await readFile(path.join(dir, 'OUT/author/0.json'), 'utf8'),
    );

    expect(written).toHaveProperty(
      ['config', 'brand', 'name'],
      'Example Tools',
    );
    expect(written).toHaveProperty(['notes', 'confidence'], 0.9);

    const journal = await readFile(
      path.join(dir, 'JOURNAL/author-0.research.jsonl'),
      'utf8',
    );
    const submitted = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { tool: string; args: unknown })
      .filter((entry) => entry.tool === 'submit');

    expect(submitted.at(-1)?.args).toEqual({
      decodedArguments: ['config', 'notes'],
    });
  });

  it('should refuse a string argument that is not JSON with a schema error, not a crash', async () => {
    const { dir, tools: t } = await tools();

    const result = payload(
      await t.call('submit', { config: '{not json', notes }),
    );

    expect(result.ok).toBe(false);
    expect(
      (result.errors as string[]).some((e) => e.startsWith('config')),
    ).toBe(true);
    await expect(stat(path.join(dir, 'OUT/author/0.json'))).rejects.toThrow();
  });

  it('should declare the read tools read-only and submit not', () => {
    const definitions = createAuthorTools({
      dir: '/nowhere',
      label: 'author-0',
      secrets: [],
      search: null,
    }).definitions;

    expect(definitions.map((tool) => tool.name)).toEqual([
      'search',
      'fetch',
      'render',
      'submit',
    ]);

    for (const tool of definitions) {
      expect(Boolean(tool.annotations?.readOnlyHint)).toBe(
        tool.name !== 'submit',
      );
    }
  });
});

describe('AuthorTools - parseRobots()', () => {
  it("should pick the agent's own group over the wildcard and apply the longest rule", () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: literally-aeo\nAllow: /docs/public\nDisallow: /docs\nDisallow:\n',
    );

    expect(rules).toEqual({
      allow: ['/docs/public'],
      disallow: ['/docs', ''],
    });

    const url = (p: string) => {
      return new URL(`https://example.com${p}`);
    };

    expect(robotsAllows(rules, url('/docs/public/a'))).toBe(true);
    expect(robotsAllows(rules, url('/docs/private'))).toBe(false);
    expect(robotsAllows(rules, url('/pricing'))).toBe(true);

    const wildcard = parseRobots('User-agent: *\nDisallow: /*.pdf$\n');

    expect(robotsAllows(wildcard, url('/a.pdf'))).toBe(false);
    expect(robotsAllows(wildcard, url('/a.pdf.html'))).toBe(true);
  });
});

describe('AuthorSearch - searchAdapterFromEnv()', () => {
  it('should search through DataForSEO only when its pair is held', async () => {
    const { searchAdapterFromEnv } = await import('./author-search');

    expect(searchAdapterFromEnv({})).toBeNull();
    expect(searchAdapterFromEnv({ EXA_API_KEY: 'exa-key' })).toBeNull();
    expect(searchAdapterFromEnv({ DATAFORSEO_LOGIN: 'login' })).toBeNull();
    expect(
      searchAdapterFromEnv({
        DATAFORSEO_LOGIN: 'login',
        DATAFORSEO_PASSWORD: 'password',
        EXA_API_KEY: 'exa-key',
      })?.provider,
    ).toBe('dataforseo-google-organic-v1');
  });
});
