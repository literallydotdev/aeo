import { describe, expect, it } from 'vitest';
import { citedHost, classifySource, countSources } from './source-classifier';
import type { SourceClassifierConfig } from './source-classifier';

const config: SourceClassifierConfig = {
  brandDomain: 'superlinked.com',
  competitorDomains: ['pinecone.io', 'weaviate.io'],
};

describe('source-classifier - classifySource()', () => {
  it('should classify brand hosts (including subdomains) as owned', () => {
    expect(classifySource('https://superlinked.com/pricing', config)).toBe(
      'owned',
    );
    expect(classifySource('https://docs.superlinked.com/x', config)).toBe(
      'owned',
    );
    expect(classifySource('https://www.superlinked.com/', config)).toBe(
      'owned',
    );
  });

  it('should classify configured competitor domains as competitor', () => {
    expect(classifySource('https://www.pinecone.io/learn/', config)).toBe(
      'competitor',
    );
    expect(classifySource('https://weaviate.io/blog/post', config)).toBe(
      'competitor',
    );
  });

  it('should classify the static social/community roster', () => {
    expect(classifySource('https://www.reddit.com/r/rag/x', config)).toBe(
      'social',
    );
    expect(classifySource('https://github.com/qdrant/qdrant', config)).toBe(
      'social',
    );
    expect(
      classifySource('https://news.ycombinator.com/item?id=1', config),
    ).toBe('social');
  });

  it('should classify encyclopedic/platform references as institutional', () => {
    expect(
      classifySource('https://en.wikipedia.org/wiki/Vector_database', config),
    ).toBe('institutional');
    expect(
      classifySource('https://cloud.google.com/vertex-ai/docs', config),
    ).toBe('institutional');
  });

  it('should default everything else to earned', () => {
    expect(
      classifySource('https://thedataquarry.com/posts/vector-db-1/', config),
    ).toBe('earned');
  });

  it('should let per-report overrides win over every static list', () => {
    const withOverride: SourceClassifierConfig = {
      ...config,
      overrides: { 'reddit.com': 'earned', 'thedataquarry.com': 'social' },
    };

    expect(classifySource('https://www.reddit.com/r/rag/x', withOverride)).toBe(
      'earned',
    );
    expect(
      classifySource('https://thedataquarry.com/posts/x', withOverride),
    ).toBe('social');
  });

  it('should return null for unparseable URLs', () => {
    expect(classifySource('not a url', config)).toBeNull();
  });

  it('should apply learned labels only where every static rule fell through', () => {
    const withLearned: SourceClassifierConfig = {
      ...config,
      learned: {
        'someagency.com': 'competitor',
        'zenn.dev': 'social',
        // A learned label never overrides a static answer.
        'reddit.com': 'earned',
        'pinecone.io': 'earned',
      },
    };

    expect(
      classifySource('https://www.someagency.com/blog/x', withLearned),
    ).toBe('competitor');
    expect(classifySource('https://blog.someagency.com/y', withLearned)).toBe(
      'competitor',
    );
    expect(classifySource('https://zenn.dev/u/post', withLearned)).toBe(
      'social',
    );
    expect(classifySource('https://www.reddit.com/r/x', withLearned)).toBe(
      'social',
    );
    expect(classifySource('https://pinecone.io/learn', withLearned)).toBe(
      'competitor',
    );
    expect(classifySource('https://unknown.example/', withLearned)).toBe(
      'earned',
    );
  });
});

describe('source-classifier - countSources()', () => {
  it('should tally classified citations and skip unparseable URLs', () => {
    expect(
      countSources(
        [
          'https://superlinked.com/x',
          'https://pinecone.io/y',
          'https://reddit.com/z',
          'https://press.example.com/a',
          'garbage',
        ],
        config,
      ),
    ).toEqual({
      owned: 1,
      competitor: 1,
      social: 1,
      institutional: 0,
      earned: 1,
    });
  });
});

describe('source-classifier - citedHost()', () => {
  it('should return only hostnames made of DNS labels', () => {
    expect(citedHost('https://www.Deno.com/deploy')).toBe('deno.com');
    expect(citedHost('https://my-app.vercel.app`')).toBeNull();
    expect(citedHost('not a url')).toBeNull();
  });
});
