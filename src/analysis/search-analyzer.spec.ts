import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import { ModelCallAbortError } from '../models/errors';
import { isRetryable, reconcileProspectMentions } from './search-analyzer';

describe('search-analyzer - isRetryable()', () => {
  it('should keep genuine provider 500s retryable while host aborts are final', () => {
    const providerError = new APICallError({
      message: 'Provider unavailable',
      url: 'https://example.invalid',
      requestBodyValues: {},
      statusCode: 500,
    });

    expect(isRetryable(providerError)).toBe(true);
    expect(
      isRetryable(new ModelCallAbortError('deadline', providerError)),
    ).toBe(false);
    expect(
      isRetryable(new ModelCallAbortError('cancelled', providerError)),
    ).toBe(false);
  });
});

describe('search-analyzer - reconcileProspectMentions()', () => {
  const brand = { name: 'Deno', domain: 'deno.com', aliases: ['Deno Deploy'] };
  it('should drop the prospect from the brand list of an answer that does not mention it', () => {
    const analyzed = {
      clientMentioned: false,
      allMentionedBrands: [
        { name: 'Netlify', domain: 'netlify.com' },
        { name: 'Deno', domain: 'deno.com' },
        { name: 'deno deploy', domain: null },
      ],
    };

    expect(
      reconcileProspectMentions(analyzed, brand).allMentionedBrands,
    ).toEqual([{ name: 'Netlify', domain: 'netlify.com' }]);
  });
  it('should leave a mentioning answer untouched', () => {
    const analyzed = {
      clientMentioned: true,
      allMentionedBrands: [{ name: 'Deno Deploy', domain: 'deno.com' }],
    };

    expect(reconcileProspectMentions(analyzed, brand)).toBe(analyzed);
  });
});
