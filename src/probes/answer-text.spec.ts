import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProbeAnswer } from './adapter';
import { finalizeAnswer, renderAnswer } from './answer-text';

// ============================================================================
// The banked answer's bytes (probe adapters spec §4.4): the source block is
// rendered, then U+0000 is stripped, then Google's redirects are resolved,
// and only for the adapters that resolve them.
// ============================================================================

const wrapped = 'https://google.com/goto?url=https://rival.example/';

afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (fields: Partial<ProbeAnswer>): ProbeAnswer => {
  return {
    answerText: '',
    sources: { format: 'none' },
    retrieval: null,
    ...fields,
  };
};

describe('answer-text - renderAnswer()', () => {
  it('should trim the body only when a search source is listed', () => {
    expect(
      renderAnswer(
        answer({
          answerText: ' Body. ',
          sources: { format: 'search', sources: [{ sourceType: 'document' }] },
        }),
      ),
    ).toBe(' Body. ');
    expect(
      renderAnswer(
        answer({
          answerText: ' Body. ',
          sources: {
            format: 'search',
            sources: [{ sourceType: 'url', url: 'https://acme.example/' }],
          },
        }),
      ),
    ).toBe(
      'Body.\n\nSources used by search:\n- https://acme.example/: https://acme.example/',
    );
  });

  it('should drop the domain label of a wrapped AI Overview reference', () => {
    expect(
      renderAnswer(
        answer({
          answerText: 'Overview.',
          sources: {
            format: 'ai_overview',
            references: [
              {
                source: 'Rival',
                domain: 'google.com',
                url: wrapped,
                title: 'Blog',
                text: '',
              },
            ],
          },
        }),
      ),
    ).toBe(
      `Overview.\n\nSources cited in AI Overview:\n- Rival: "Blog" — ${wrapped}`,
    );
  });
});

describe('answer-text - finalizeAnswer()', () => {
  const overview = answer({
    answerText: 'Rival\u0000 Files.',
    sources: {
      format: 'ai_overview',
      references: [
        {
          source: 'Rival\u0000',
          domain: 'google.com',
          url: wrapped,
          title: 'Blog',
          text: '',
        },
      ],
    },
  });

  it('should strip U+0000 from the rendered text, sources included, and resolve redirects after', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://rival.example/' },
          }),
        ),
      ),
    );

    const final = await finalizeAnswer(overview, { resolvesRedirects: true });

    expect(final.text).toBe(
      'Rival Files.\n\nSources cited in AI Overview:\n- Rival: "Blog" — https://rival.example/',
    );
  });

  it('should NOT resolve redirects for an adapter that keeps them', async () => {
    const fetch = vi.fn();

    vi.stubGlobal('fetch', fetch);

    const final = await finalizeAnswer(overview, { resolvesRedirects: false });

    expect(final.text).toContain(wrapped);
    expect(fetch).not.toHaveBeenCalled();
  });
});
