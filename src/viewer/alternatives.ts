import { normalizeDomain } from '../report/core/normalize-domain';
import { qualifiedCompetitorsForRow } from '../report/core/qualified-competitors';
import type { AeoMatrixRow } from '../report/core/schema';

// ============================================================================
// "Who buyers hear about instead": a section's qualified alternatives,
// grouped as the hosted report groups them (its `groupAlternatives`), so a
// business carries one name and one count on both pages. Entries on one
// domain are one alternative; a name given without a domain joins the one
// domain whose answers used that name.
// ============================================================================

export type RankedAlternative = {
  name: string;
  domain?: string;
  /** Answers that name the alternative, each counted once. */
  mentioning: number;
  captured: number;
};

type Sighting = {
  key: string;
  domain?: string;
  // Every spelling the answers used, with the rows that used it.
  names: Map<string, Set<number>>;
  rowIndices: Set<number>;
};

type Prospect = { name: string; domain: string };

/** rankAlternatives orders a section's alternatives by the answers that
 * name them, most first. */
export const rankAlternatives = (
  matrix: ReadonlyArray<
    Pick<AeoMatrixRow, 'qualifiedCompetitors' | 'competitors'>
  >,
  prospect: Prospect,
): RankedAlternative[] => {
  const isProspect = matchesProspect(prospect);
  const ranked = [...foldNameOnlySightings(collectSightings(matrix)).values()]
    .filter((sighting) => !isProspect(sighting))
    .map((sighting) => ({
      name: displayName(sighting),
      ...(sighting.domain !== undefined && { domain: sighting.domain }),
      mentioning: sighting.rowIndices.size,
      captured: matrix.length,
    }))
    .sort(
      (a, b) => b.mentioning - a.mentioning || a.name.localeCompare(b.name),
    );

  return ranked;
};

const collectSightings = (
  matrix: ReadonlyArray<
    Pick<AeoMatrixRow, 'qualifiedCompetitors' | 'competitors'>
  >,
): Map<string, Sighting> => {
  const sightings = new Map<string, Sighting>();

  matrix.forEach((row, rowIndex) => {
    for (const brand of qualifiedCompetitorsForRow(row)) {
      const name = brand.name.trim();
      const domain = brand.domain ? normalizeDomain(brand.domain) : undefined;
      const key = domain ?? name.toLowerCase();
      const sighting = sightings.get(key) ?? {
        key,
        names: new Map<string, Set<number>>(),
        rowIndices: new Set<number>(),
      };
      const nameRows = sighting.names.get(name) ?? new Set<number>();

      // A name-only first sighting takes the domain a later entry supplies.
      sighting.domain ??= domain;
      nameRows.add(rowIndex);
      sighting.names.set(name, nameRows);
      sighting.rowIndices.add(rowIndex);
      sightings.set(key, sighting);
    }
  });

  return sightings;
};

// The analyzer sometimes returns one brand with and without a domain, which
// lands under two keys.
const foldNameOnlySightings = (
  sightings: ReadonlyMap<string, Sighting>,
): Map<string, Sighting> => {
  const domainKeysByName = new Map<string, Set<string>>();

  for (const sighting of sightings.values()) {
    if (sighting.domain === undefined) {
      continue;
    }

    for (const name of sighting.names.keys()) {
      const lowered = name.toLowerCase();
      const keys = domainKeysByName.get(lowered) ?? new Set<string>();

      keys.add(sighting.key);
      domainKeysByName.set(lowered, keys);
    }
  }

  const folded = new Map(sightings);

  for (const sighting of sightings.values()) {
    if (sighting.domain !== undefined) {
      continue;
    }

    const [ownerKey, ...otherKeys] = [
      ...(domainKeysByName.get(sighting.key) ?? []),
    ];
    const owner = ownerKey === undefined ? undefined : folded.get(ownerKey);

    if (!owner || otherKeys.length > 0) {
      continue;
    }

    folded.set(owner.key, mergeSightings(owner, sighting));
    folded.delete(sighting.key);
  }

  return folded;
};

const mergeSightings = (owner: Sighting, nameOnly: Sighting): Sighting => {
  const names = new Map(
    [...owner.names].map(([name, rows]) => [name, new Set(rows)]),
  );

  for (const [name, rows] of nameOnly.names) {
    names.set(name, new Set([...(names.get(name) ?? []), ...rows]));
  }

  const merged = {
    ...owner,
    names,
    rowIndices: new Set([...owner.rowIndices, ...nameOnly.rowIndices]),
  };

  return merged;
};

/**
 * displayName labels an alternative by what all its mentions share. When
 * every name the answers used starts with the shortest one ("Rivalstack",
 * "Rivalstack Edge"), that name, in its most-used spelling. Otherwise the
 * entries are different products of one vendor, and the domain names the
 * alternative, so no product is credited with its siblings' mentions.
 */
const displayName = (sighting: Sighting): string => {
  const spellings = [...sighting.names].map(([name, rows]) => ({
    name,
    words: name.toLowerCase().split(/\s+/),
    answers: rows.size,
  }));
  const [base] = [...spellings].sort(
    (a, b) =>
      a.words.length - b.words.length ||
      b.answers - a.answers ||
      a.name.localeCompare(b.name),
  );

  if (!base) {
    throw new Error(`Alternative has no recorded name: ${sighting.key}.`);
  }

  const isSharedBase = spellings.every((spelling) =>
    base.words.every((word, index) => spelling.words[index] === word),
  );

  if (!isSharedBase && sighting.domain !== undefined) {
    return sighting.domain;
  }

  // The base name's spellings ("RivalStack", "Rivalstack"): the one most answers used.
  const [label] = spellings
    .filter((spelling) => spelling.words.length === base.words.length)
    .sort((a, b) => b.answers - a.answers || a.name.localeCompare(b.name));

  return (label ?? base).name;
};

const matchesProspect = (prospect: Prospect) => {
  const prospectName = prospect.name.trim().toLowerCase();
  const prospectDomain = normalizeDomain(prospect.domain);

  return (sighting: Sighting): boolean => {
    const identity = sighting.domain ?? sighting.key;
    const isProspectDomain =
      identity === prospectDomain || identity.endsWith(`.${prospectDomain}`);
    const isProspectName = [...sighting.names.keys()].some(
      (name) => name.toLowerCase() === prospectName,
    );

    return isProspectDomain || isProspectName;
  };
};
