import { describe, expect, it } from 'vitest';
import type { RetrievalCall, RetrievalLog } from '../schema';
import { attributeCitations, summarizeRetrievalCalls } from './retrieval';

// Retrieval-log spec §10: attribution and row-summary derivations are pure
// functions of stored probe data.

const search = (
  query: string,
  resultUrls: string[] | null,
  resultsComplete = true,
): RetrievalCall => {
  return { kind: 'search', query, url: null, resultUrls, resultsComplete };
};

const fetchCall = (url: string): RetrievalCall => {
  return {
    kind: 'fetch',
    query: null,
    url,
    resultUrls: [url],
    resultsComplete: true,
  };
};

const log = (calls: RetrievalCall[]): RetrievalLog => {
  return { exposure: 'full', calls };
};

const brand = { domain: 'acme.example' };
const competitors = [{ domain: 'netapp.com' }, { domain: 'nutanix.com' }];

describe('retrieval - attributeCitations()', () => {
  it('should attribute a cited URL to one, two, or no result sets', () => {
    const retrieval = log([
      search('a', ['https://acme.example/pricing', 'https://netapp.com/x']),
      search('b', ['https://acme.example/pricing']),
      search('c', null),
    ]);

    expect(
      attributeCitations(
        [
          'https://acme.example/pricing',
          'https://netapp.com/x',
          'https://example.com/from-memory',
        ],
        retrieval,
      ),
    ).toEqual([
      { url: 'https://acme.example/pricing', callIndices: [0, 1] },
      { url: 'https://netapp.com/x', callIndices: [0] },
      { url: 'https://example.com/from-memory', callIndices: [] },
    ]);
  });

  it('should match across trailing-slash and utm_* differences', () => {
    const retrieval = log([
      search('a', ['https://acme.example/pricing/?utm_source=openai']),
    ]);

    expect(
      attributeCitations(['https://acme.example/pricing'], retrieval),
    ).toEqual([{ url: 'https://acme.example/pricing', callIndices: [0] }]);
  });

  it('should leave an unparseable cited string unattributed', () => {
    expect(attributeCitations(['not a url'], log([search('a', [])]))).toEqual([
      { url: 'not a url', callIndices: [] },
    ]);
  });
});

describe('retrieval - summarizeRetrievalCalls()', () => {
  it('should flag brand and competitor presence per search with result counts', () => {
    const summaries = summarizeRetrievalCalls(
      log([
        search('best nas', [
          'https://docs.acme.example/start',
          'https://www.nutanix.com/products',
          'https://reddit.com/r/x',
        ]),
        search('nas vendors', ['https://reddit.com/r/y']),
      ]),
      brand,
      competitors,
    );

    expect(summaries).toEqual([
      {
        kind: 'search',
        query: 'best nas',
        url: null,
        brandFound: true,
        competitorsFound: ['nutanix.com'],
        resultCount: 3,
      },
      {
        kind: 'search',
        query: 'nas vendors',
        url: null,
        brandFound: false,
        competitorsFound: [],
        resultCount: 1,
      },
    ]);
  });

  it('should NOT count a look-alike domain as the brand', () => {
    const [summary] = summarizeRetrievalCalls(
      log([search('q', ['https://notacme.example/'])]),
      brand,
      competitors,
    );

    expect(summary?.brandFound).toBe(false);
  });

  it('should store null for unexposed results and for an incomplete false', () => {
    const summaries = summarizeRetrievalCalls(
      log([
        search('queries only', null),
        search('chatgpt cited subset', ['https://netapp.com/a'], false),
        search('chatgpt cited brand', ['https://acme.example/a'], false),
      ]),
      brand,
      competitors,
    );

    expect(summaries.map((s) => [s.brandFound, s.resultCount])).toEqual([
      [null, null],
      [null, 1],
      [true, 1],
    ]);
    expect(summaries[1]?.competitorsFound).toEqual(['netapp.com']);
  });

  it('should mark a fetch of a brand subdomain as found and a look-alike as not', () => {
    const summaries = summarizeRetrievalCalls(
      log([
        fetchCall('https://docs.acme.example/pricing'),
        fetchCall('https://acme.example.evil.io/'),
        fetchCall('https://www.netapp.com/pricing'),
      ]),
      brand,
      competitors,
    );

    expect(
      summaries.map((s) => [s.kind, s.brandFound, s.competitorsFound]),
    ).toEqual([
      ['fetch', true, []],
      ['fetch', false, []],
      ['fetch', false, ['netapp.com']],
    ]);
    expect(summaries.every((s) => s.resultCount === null)).toBe(true);
  });

  it('should drop a call with neither a query nor a URL from the row summary', () => {
    const summaries = summarizeRetrievalCalls(
      log([
        search('', ['https://acme.example/']),
        {
          kind: 'open_page',
          query: null,
          url: '',
          resultUrls: null,
          resultsComplete: false,
        },
        search('kept', null),
      ]),
      brand,
      competitors,
    );

    expect(summaries.map((s) => s.query)).toEqual(['kept']);
  });
});
