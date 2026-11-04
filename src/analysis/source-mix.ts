import type { AeoSnapshot, AeoSurface, AeoVisibility } from '../schema';
import { isGroundingRedirectUrl } from '../probes/grounding-urls';
import {
  addSourceMixCounts,
  countSources,
  emptySourceMixCounts,
  sectionSourceClassifierConfig,
  type SourceClassifierConfig,
} from './source-classifier';

// ============================================================================
// Citation mix (spec §7.1) over finished sections: every cited URL per
// surface, classified and tallied. Pure derivation over the matrix, shared
// by the runner (aeo/run.ts) and the in-place relabel command
// (aeo/relabel.ts) so both produce the same block from the same rows.
// ============================================================================

export const buildSourceMix = (
  sections: ReadonlyArray<{ key: string; visibility: AeoVisibility }>,
  classifierConfig: SourceClassifierConfig,
): NonNullable<AeoSnapshot['sourceMix']> => {
  return {
    sections: sections.map(({ key, visibility }) => {
      const sectionConfig = sectionSourceClassifierConfig(
        classifierConfig,
        visibility,
        sections,
      );
      const bySurface = new Map<AeoSurface, string[]>();

      for (const row of visibility.matrix) {
        const urls = (row.citedUrls ?? []).filter(
          (url) => !isGroundingRedirectUrl(url),
        );

        if (urls.length === 0) {
          continue;
        }

        const existing = bySurface.get(row.surface) ?? [];
        bySurface.set(row.surface, [...existing, ...urls]);
      }

      const perSurface = [...bySurface.entries()].map(([surface, urls]) => ({
        surface,
        counts: countSources(urls, sectionConfig),
      }));
      const total = perSurface.reduce(
        (acc, entry) => addSourceMixCounts(acc, entry.counts),
        emptySourceMixCounts(),
      );

      return { key, perSurface, total };
    }),
  };
};
