import { describe, expect, it } from 'vitest';
import { locateVerbatimPassage } from './verbatim';

const answer = [
  '## Options',
  '',
  '- **Deno Deploy** — the simplest *TypeScript-first* option; run `.ts` files directly.',
  '- Vercel: “batteries included”, but it’s Node-centric.',
].join('\n');

describe('verbatim - locateVerbatimPassage()', () => {
  it('should return an exact substring unchanged', () => {
    expect(locateVerbatimPassage(answer, 'run `.ts` files directly')).toBe(
      'run `.ts` files directly',
    );
  });

  it('should see through dropped markdown and return the answer’s own passage', () => {
    expect(
      locateVerbatimPassage(
        answer,
        'Deno Deploy — the simplest TypeScript-first option; run .ts files directly',
      ),
    ).toBe(
      '**Deno Deploy** — the simplest *TypeScript-first* option; run `.ts` files directly',
    );
  });

  it('should see through collapsed whitespace and straightened quotes and dashes', () => {
    expect(locateVerbatimPassage(answer, 'Deno Deploy - the   simplest')).toBe(
      '**Deno Deploy** — the simplest',
    );
    expect(
      locateVerbatimPassage(answer, 'Vercel: "batteries included", but it\'s'),
    ).toBe('Vercel: “batteries included”, but it’s');
  });

  it('should refuse a phrase whose words differ, and empty phrases', () => {
    expect(locateVerbatimPassage(answer, 'Deno Deploy is the simplest')).toBe(
      null,
    );
    expect(locateVerbatimPassage(answer, 'the easiest option')).toBe(null);
    expect(locateVerbatimPassage(answer, '')).toBe(null);
    expect(locateVerbatimPassage(answer, '**')).toBe(null);
  });
});
