import type { AeoMatrixRow } from './schema';

/** The row's section-qualified alternatives; old captures retain seed-only data. */
export const qualifiedCompetitorsForRow = (
  row: Pick<AeoMatrixRow, 'qualifiedCompetitors' | 'competitors'>,
): Array<{ name: string; domain: string | null }> => {
  // An assessed empty list is authoritative, including for configured seeds.
  if (row.qualifiedCompetitors !== undefined) {
    return row.qualifiedCompetitors;
  }

  return row.competitors
    .filter((competitor) => competitor.mentioned)
    .map(({ domain }) => ({ name: domain, domain }));
};
