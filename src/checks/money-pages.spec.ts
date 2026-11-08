import { describe, expect, it } from 'vitest';
import { moneyPageProblem } from './money-pages';

// ============================================================================
// The money-page rule every admission shares: which pages the site checks
// may fetch. The audit.json and author wording around it are tested where
// each is written.
// ============================================================================

const site = { domain: 'acme.example' };

describe('money-pages - moneyPageProblem()', () => {
  it.each([
    ['the apex', 'https://acme.example/pricing'],
    ['www', 'https://www.acme.example/'],
    ['a subdomain', 'https://docs.acme.example/start'],
  ])('should accept a page on %s of the brand site', (_case, page) => {
    expect(moneyPageProblem(page, site)).toBeUndefined();
  });

  it('should accept a page on a host the operator allowed, and NOT a look-alike', () => {
    const allowed = { ...site, checkHosts: ['acme-docs.example'] };

    expect(
      moneyPageProblem('https://guide.acme-docs.example/', allowed),
    ).toBeUndefined();
    expect(moneyPageProblem('https://notacme.example/', allowed)).toEqual({
      kind: 'off_site',
    });
  });

  it('should call a page on another site off_site, whatever its scheme', () => {
    expect(moneyPageProblem('https://rival.example/', site)).toEqual({
      kind: 'off_site',
    });
    expect(moneyPageProblem('http://rival.example/', site)).toEqual({
      kind: 'off_site',
    });
  });

  it.each([
    ['plain http', 'http://acme.example/pricing'],
    ['a port', 'https://acme.example:8443/'],
    ['credentials', 'https://user:secret@acme.example/'],
  ])('should refuse an on-site page with %s as unsafe', (_case, page) => {
    expect(moneyPageProblem(page, site)).toMatchObject({
      kind: 'unsafe_url',
    });
  });

  it('should refuse a private address even when it is the brand domain', () => {
    expect(
      moneyPageProblem('https://10.0.0.1/', { domain: '10.0.0.1' }),
    ).toMatchObject({ kind: 'unsafe_url' });
  });
});
