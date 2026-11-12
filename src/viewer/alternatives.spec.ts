import { describe, expect, it } from 'vitest';
import type { AeoMatrixRow } from '../report/core/schema';
import { rankAlternatives } from './alternatives';

type Row = Pick<AeoMatrixRow, 'qualifiedCompetitors' | 'competitors'>;

const named = (
  ...brands: Array<[name: string, domain: string | null]>
): Row => ({
  competitors: [],
  qualifiedCompetitors: brands.map(([name, domain]) => ({ name, domain })),
});

const prospect = { name: 'Acmebase', domain: 'acmebase.test' };

describe('viewer - rankAlternatives()', () => {
  it('should count each answer once per alternative, most named first', () => {
    const ranked = rankAlternatives(
      [
        named(
          ['Rivalstack', 'rivalstack.test'],
          ['Othertool', 'othertool.test'],
        ),
        named(['Rivalstack', 'www.rivalstack.test']),
        named(
          ['Rivalstack', 'rivalstack.test'],
          ['Rivalstack', 'rivalstack.test'],
        ),
      ],
      prospect,
    );

    expect(ranked).toEqual([
      {
        name: 'Rivalstack',
        domain: 'rivalstack.test',
        mentioning: 3,
        captured: 3,
      },
      {
        name: 'Othertool',
        domain: 'othertool.test',
        mentioning: 1,
        captured: 3,
      },
    ]);
  });

  it('should fold a name given without a domain into the one domain that used it', () => {
    const ranked = rankAlternatives(
      [named(['Rivalstack', null]), named(['Rivalstack', 'rivalstack.test'])],
      prospect,
    );

    expect(ranked).toEqual([
      {
        name: 'Rivalstack',
        domain: 'rivalstack.test',
        mentioning: 2,
        captured: 2,
      },
    ]);
  });

  it('should name a vendor by its domain when its products share no base name', () => {
    const ranked = rankAlternatives(
      [
        named(['Rival Assist', 'rival.test']),
        named(['Rivalbot', 'rival.test']),
      ],
      prospect,
    );

    expect(ranked.map(({ name }) => name)).toEqual(['rival.test']);
  });

  it('should leave the brand itself out, by domain or by name', () => {
    const ranked = rankAlternatives(
      [named(['Acme Docs', 'docs.acmebase.test'], ['acmebase', null])],
      prospect,
    );

    expect(ranked).toEqual([]);
  });

  it('should rank the mentioned seed competitors of an answer analysed before qualification', () => {
    const ranked = rankAlternatives(
      [
        {
          competitors: [
            { domain: 'rivalstack.test', mentioned: true },
            { domain: 'othertool.test', mentioned: false },
          ],
        },
      ],
      prospect,
    );

    expect(ranked).toEqual([
      {
        name: 'rivalstack.test',
        domain: 'rivalstack.test',
        mentioning: 1,
        captured: 1,
      },
    ]);
  });
});
