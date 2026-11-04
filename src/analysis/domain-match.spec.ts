import { describe, expect, it } from 'vitest';
import { normalizeDomain } from './scoring';
import {
  hostMatchesDomain,
  isDomainCited,
  urlIsOnDomain,
} from './domain-match';

describe('domain-match - hostMatchesDomain()', () => {
  it('should match the apex, www, and subdomains', () => {
    expect(hostMatchesDomain('acme.example', 'acme.example')).toBe(true);
    expect(hostMatchesDomain('www.acme.example', 'acme.example')).toBe(true);
    expect(hostMatchesDomain('docs.acme.example', 'acme.example')).toBe(true);
    expect(hostMatchesDomain('acme.example', 'www.acme.example')).toBe(true);
  });

  it('should reject look-alike domains', () => {
    expect(hostMatchesDomain('notacme.example', 'acme.example')).toBe(false);
    expect(hostMatchesDomain('acme.example.evil.io', 'acme.example')).toBe(
      false,
    );
  });

  it('should accept a configured domain given as a URL', () => {
    expect(hostMatchesDomain('acme.example', 'https://acme.example/')).toBe(
      true,
    );
  });
});

describe('domain-match - isDomainCited() (deterministic citation, spec §3.4)', () => {
  it('should cite the brand on apex and subdomain URLs', () => {
    expect(
      isDomainCited(['https://acme.example/products/files/'], 'acme.example'),
    ).toBe(true);
    expect(isDomainCited(['https://docs.acme.example/x'], 'acme.example')).toBe(
      true,
    );
  });

  it('should NOT cite on a look-alike domain', () => {
    expect(isDomainCited(['https://notacme.example/'], 'acme.example')).toBe(
      false,
    );
  });

  it('should cite a competitor by its own domain only', () => {
    const urls = ['https://www.other.example/', 'https://jcifs.other.example/'];

    expect(isDomainCited(urls, 'other.example')).toBe(true);
    expect(isDomainCited(urls, 'rival.example')).toBe(false);
  });

  it('should be false with no URLs in the answer, however strongly a model might infer one', () => {
    expect(isDomainCited([], 'acme.example')).toBe(false);
    expect(urlIsOnDomain('not a url', 'acme.example')).toBe(false);
  });
});

describe('domain-match - host normalization edge cases (hardening spec §2.10)', () => {
  it('should strip a trailing dot from the host', () => {
    expect(hostMatchesDomain('example.com.', 'example.com')).toBe(true);
    expect(urlIsOnDomain('https://www.example.com./x', 'example.com')).toBe(
      true,
    );
  });

  it('should lower-case and strip www. and the trailing dot in normalizeDomain()', () => {
    expect(normalizeDomain('WWW.Example.com.')).toBe('example.com');
    expect(normalizeDomain('https://www.example.com/path')).toBe('example.com');
    expect(normalizeDomain('example.com')).toBe('example.com');
  });
});
