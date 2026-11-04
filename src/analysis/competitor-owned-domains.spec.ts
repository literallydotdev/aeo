import { assert, describe, expect, it } from 'vitest';
import { z } from 'zod';
import configFixture from '../__fixtures__/replay/literally-2026-q3/config.json';
import { aeoAuditConfigSchema } from '../schema';
import { authorOutputSchema } from '../agents/author-validation';

// The exclusion itself is applied by the Codex qualify check
// (codex-workflow/checks.ts, tested in codex-workflow/stage.spec.ts); this
// file pins the config contract the check reads.

describe('schema - aeoAuditConfigSchema competitorQualification', () => {
  it('should validate stored hosts without transforms', () => {
    const input = {
      ...configFixture,
      competitorQualification: { ownedDomains: [' WWW.MergeQueue.COM. '] },
    };

    const config = aeoAuditConfigSchema.parse(input);

    expect(config.competitorQualification).toEqual({
      ownedDomains: ['WWW.MergeQueue.COM.'],
    });
    expect(
      aeoAuditConfigSchema.parse(JSON.parse(JSON.stringify(config))),
    ).toEqual(config);
  });

  it.each([
    'https://mergequeue.com',
    'mergequeue.com/path',
    'mergequeue.com:443',
    '*.mergequeue.com',
    'user@mergequeue.com',
    'localhost',
    '127.0.0.1',
    '',
  ])('should reject the owned domain %j', (domain) => {
    const input = {
      ...configFixture,
      competitorQualification: { ownedDomains: [domain] },
    };

    const parsed = aeoAuditConfigSchema.safeParse(input);

    expect(parsed.success).toBe(false);
  });

  it('should reject aliases without owned domains', () => {
    const input = {
      ...configFixture,
      competitorQualification: { ownedDomains: [], aliases: ['merge queue'] },
    };

    const parsed = aeoAuditConfigSchema.safeParse(input);

    expect(parsed.success).toBe(false);
  });

  it('should export full config constraints while keeping ownership exclusions out of generated author output', () => {
    const schema = z.toJSONSchema(aeoAuditConfigSchema);
    const qualification = schema.properties
      ?.competitorQualification as z.core.JSONSchema.JSONSchema;
    const hosts = qualification.properties
      ?.ownedDomains as z.core.JSONSchema.JSONSchema;
    const item = hosts.items as z.core.JSONSchema.JSONSchema;
    const { pattern } = item;

    assert(pattern);
    expect(hosts.type).toBe('array');
    expect(hosts.minItems).toBe(1);
    expect(hosts.maxItems).toBe(20);
    expect(item.type).toBe('string');
    expect(new RegExp(pattern).test('mergequeue.com')).toBe(true);
    expect(new RegExp(pattern).test('WWW.MergeQueue.COM.')).toBe(true);
    expect(new RegExp(pattern).test('https://mergequeue.com')).toBe(false);

    // This is the same export used by author/build-context.ts during aeo:build.
    const authored = z.toJSONSchema(authorOutputSchema);
    const validAuthor = authorOutputSchema.strip().parse(configFixture);

    expect(authored.properties).not.toHaveProperty('competitorQualification');
    expect(authorOutputSchema.safeParse(validAuthor).success).toBe(true);
    expect(
      authorOutputSchema.safeParse({
        ...validAuthor,
        competitorQualification: { ownedDomains: ['trunk.io'] },
      }).success,
    ).toBe(false);
  });
});
