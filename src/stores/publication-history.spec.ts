import { describe, expect, it } from 'vitest';
import { publicationDate } from './publication-history';

const reportGeneratedAt = '2026-08-25T14:19:42.797Z';

describe('publication-history - publicationDate()', () => {
  it('should keep a recorded publication date over the report date', () => {
    expect(
      publicationDate({
        firstPublishedAt: new Date('2026-10-16T16:44:07.657Z'),
        origin: 'backfill',
        reportGeneratedAt,
      }),
    ).toBe('2026-10-16T16:44:07.657Z');
  });

  it.each(['backfill', 'legacy_import'] as const)(
    'should date an undated %s row by its report',
    (origin) => {
      expect(
        publicationDate({ firstPublishedAt: null, origin, reportGeneratedAt }),
      ).toBe(reportGeneratedAt);
    },
  );

  it('should NOT infer a date for a publication row or from an invalid report date', () => {
    expect(
      publicationDate({
        firstPublishedAt: null,
        origin: 'publication',
        reportGeneratedAt,
      }),
    ).toBeNull();
    expect(
      publicationDate({
        firstPublishedAt: null,
        origin: 'backfill',
        reportGeneratedAt: 'not a date',
      }),
    ).toBeNull();
  });
});
