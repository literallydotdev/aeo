import { describe, expect, it } from 'vitest';
import {
  maxAnswerChars,
  truncationMarker,
  citedUrlKey,
  extractCitedUrls,
  truncateAnswer,
} from './answer-text';

describe('answer-text - truncateAnswer()', () => {
  it('should return short answers untouched', () => {
    const result = truncateAnswer('short answer');

    expect(result).toEqual({
      text: 'short answer',
      truncated: false,
      originalChars: 12,
    });
  });

  it('should keep the head and the trailing Sources block with a visible marker', () => {
    const sources =
      'Sources used by search:\n- Docs: https://acme.example/products/files/';
    const body = 'x'.repeat(maxAnswerChars + 5_000);
    const text = `${body}\n\n${sources}`;
    const result = truncateAnswer(text);

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(text.length);
    expect(result.text.startsWith('xxxx')).toBe(true);
    expect(result.text).toContain(truncationMarker);
    expect(result.text.endsWith(sources)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(
      maxAnswerChars + truncationMarker.length,
    );
  });

  it('should honor a custom ceiling', () => {
    const result = truncateAnswer('a'.repeat(100) + 'b'.repeat(100), 50);

    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/^a+\n\n\[… truncated …\]\n\nb+$/);
  });
});

describe('answer-text - extractCitedUrls()', () => {
  it('should extract URLs from the answer text in order, stripping trailing punctuation', () => {
    const text =
      'See https://acme.example/products/files/. Also (https://rival.example/product) and https://other.example/docs.';

    expect(extractCitedUrls(text)).toEqual([
      'https://acme.example/products/files/',
      'https://rival.example/product',
      'https://other.example/docs',
    ]);
  });

  it('should dedupe by normalized URL (trailing slash, utm params) but store the original', () => {
    const text = [
      'https://example.com/post/',
      'https://example.com/post',
      'https://example.com/post?utm_source=chatgpt.com',
      'https://example.com/post?ref=other',
    ].join('\n');

    expect(extractCitedUrls(text)).toEqual([
      'https://example.com/post/',
      'https://example.com/post?ref=other',
    ]);
  });

  it('should lift the old 8-URL cap but keep a ceiling', () => {
    const many = Array.from(
      { length: 80 },
      (_, i) => `https://example.com/p${i}`,
    ).join(' ');

    expect(extractCitedUrls(many)).toHaveLength(64);
    expect(extractCitedUrls(many, 10)).toHaveLength(10);
  });

  it('should ignore non-http schemes and malformed candidates', () => {
    expect(citedUrlKey('ftp://example.com/x')).toBeNull();
    expect(citedUrlKey('https://')).toBeNull();
    expect(extractCitedUrls('mailto:x@y.z and https://ok.example/')).toEqual([
      'https://ok.example/',
    ]);
  });

  it('should NOT extract URLs from a markdown link label bracket', () => {
    expect(
      extractCitedUrls(
        '[Firecrawl Crawl API](https://www.firecrawl.dev/crawl)',
      ),
    ).toEqual(['https://www.firecrawl.dev/crawl']);
  });
});

describe('answer-text - extractCitedUrls() with parentheses', () => {
  it('should keep balanced parentheses inside a URL and drop an unbalanced closing one', () => {
    const text = [
      'See https://en.wikipedia.org/wiki/Vector_database_(software) for context,',
      'and [the trends](https://www.averi.ai/how-to/trends-(and-more)) too',
      '(also https://example.com/plain).',
    ].join(' ');

    expect(extractCitedUrls(text)).toEqual([
      'https://en.wikipedia.org/wiki/Vector_database_(software)',
      'https://www.averi.ai/how-to/trends-(and-more)',
      'https://example.com/plain',
    ]);
  });
});

describe('answer-text - extractCitedUrls() with markdown marks', () => {
  it('should stop a URL at a closing backtick or asterisk', () => {
    expect(
      extractCitedUrls(
        'Preview at `https://my-app-git-feature.vercel.app` and *https://deno.com/deploy* today.',
      ),
    ).toEqual([
      'https://my-app-git-feature.vercel.app',
      'https://deno.com/deploy',
    ]);
  });
});
