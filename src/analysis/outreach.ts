import type { AeoOutreachTargets, AeoVisibility } from '../schema';
import { isGroundingRedirectUrl } from '../probes/grounding-urls';
import {
  classifySource,
  sectionSourceClassifierConfig,
  type SourceClassifierConfig,
} from './source-classifier';
import { qualifiedCompetitorsForRow } from './qualified-competitors';

// ============================================================================
// Outreach target derivation (spec §7.3). Pure derivation over the matrix:
// domains cited in answers where the client is absent and a competitor is
// mentioned, ranked by frequency, excluding owned/competitor domains — the
// citation-gap → digital PR hit list. Human judgment decides what to pursue;
// this only surfaces the candidates.
// ============================================================================

const maxTargets = 20;
const maxSampleUrls = 5;

export const deriveOutreachTargets = (
  sections: Array<{ key: string; visibility: AeoVisibility }>,
  config: SourceClassifierConfig,
): AeoOutreachTargets => {
  const targets = new Map<
    string,
    {
      citations: number;
      prompts: Set<string>;
      sampleUrls: Set<string>;
    }
  >();

  for (const section of sections) {
    const sectionConfig = sectionSourceClassifierConfig(
      config,
      section.visibility,
      sections,
    );

    for (const row of section.visibility.matrix) {
      if (row.prospectMentioned) {
        continue;
      }

      const competitorMentioned = qualifiedCompetitorsForRow(row).length > 0;

      if (!competitorMentioned) {
        continue;
      }

      for (const url of row.citedUrls ?? []) {
        if (isGroundingRedirectUrl(url)) {
          continue;
        }

        const category = classifySource(url, sectionConfig);

        // Owned/competitor domains are not outreach targets; social threads
        // and encyclopedias are separate plays — earned media only.
        if (category !== 'earned') {
          continue;
        }

        let host: string;

        try {
          host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        } catch {
          continue;
        }

        const entry = targets.get(host) ?? {
          citations: 0,
          prompts: new Set<string>(),
          sampleUrls: new Set<string>(),
        };
        targets.set(host, entry);
        entry.citations += 1;
        entry.prompts.add(`${section.key}:${row.promptIdx}`);

        if (entry.sampleUrls.size < maxSampleUrls) {
          entry.sampleUrls.add(url);
        }
      }
    }
  }

  return [...targets.entries()]
    .map(([domain, entry]) => ({
      domain,
      citations: entry.citations,
      prompts: [...entry.prompts].map((key) => {
        const idx = key.lastIndexOf(':');

        return {
          sectionKey: key.slice(0, idx),
          promptIdx: Number(key.slice(idx + 1)),
        };
      }),
      sampleUrls: [...entry.sampleUrls],
    }))
    .sort(
      (a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain),
    )
    .slice(0, maxTargets);
};
