import { plannedProbeUnitsForSection } from '../lib/checkpoint';
import type { AeoAuditConfig, AeoSnapshot, AeoSurface } from '../schema';
import { allSurfaces, isAgentSurface, surfaceLabels } from '../surfaces';
import type { ReportFact } from './facts';
import { pendingReportCopy } from './copy-schema';

const capturedSurfaceNames = (
  surfaces: ReadonlySet<AeoSurface>,
  /** The snapshot's own labels, for surfaces asked of another model. */
  labels: Readonly<Record<string, string>>,
): string => {
  const captured = allSurfaces.filter((surface) => surfaces.has(surface));
  const names = (agents: boolean) => {
    const joined = captured
      .filter((surface) => isAgentSurface(surface) === agents)
      .map((surface) => labels[surface] ?? surfaceLabels[surface])
      .join(', ');

    return joined === '' ? 'none' : joined;
  };

  return `Captured chat and search assistants: ${names(false)}. Captured coding agents: ${names(true)}.`;
};

/**
 * buildNarrativeFacts builds the introduction facts. Additive fact IDs let
 * introductions discuss the actual market and sample without changing any
 * observation already used by a published receipt.
 */
export const buildNarrativeFacts = (
  snapshot: AeoSnapshot,
  config: AeoAuditConfig,
  runId: string,
): ReportFact[] => {
  const facts: ReportFact[] = [];
  const base = {
    kind: 'measurement' as const,
    runId,
    surface: null,
    entity: config.brand.name,
  };
  const labels = snapshot.meta.surfaceLabels ?? {};
  const capturedSurfaces = new Set(
    snapshot.sections.flatMap((section) =>
      section.visibility.matrix.map((row) => row.surface),
    ),
  );
  facts.push(
    {
      ...base,
      factId: 'scope:report',
      section: null,
      metric: 'report_identity',
      numerator: null,
      denominator: null,
      unit: 'check',
      sentence: `This report is an answer engine optimization (AEO) audit of ${config.brand.name}, prepared by ${pendingReportCopy(config).preparedBy}. This report identity does not establish particular surface coverage, customer behavior, product quality, rankings or causal effects. Those claims require their own evidence.`,
    },
    {
      ...base,
      factId: 'scope:surfaces',
      section: null,
      metric: 'captured_surfaces',
      numerator: capturedSurfaces.size,
      denominator: null,
      unit: 'count',
      sentence: `This audit of ${config.brand.name} covers the surfaces with captured answers. ${capturedSurfaceNames(capturedSurfaces, labels)} Planned surfaces without captured answers are not included in this list; it does not describe every available AI product.`,
    },
    {
      ...base,
      factId: 'scope:mentions-citations',
      section: null,
      metric: 'mention_citation_definition',
      numerator: null,
      denominator: null,
      unit: 'check',
      sentence: `This report measures mentions and citations of ${config.brand.name} separately. A mention records whether a captured answer names the company. A citation records an explicit reference to the brand domain, ${config.brand.domain}, in the captured answer or its structured citations. A mention does not require a link; a citation does not by itself establish a recommendation or favorable opinion.`,
    },
  );

  for (const section of snapshot.sections) {
    const configured = config.sections.find(({ key }) => key === section.key);

    if (!configured) {
      throw new Error(
        `Snapshot section is missing from the audit config: ${section.key}.`,
      );
    }

    const market = section.key.replaceAll('_', ' ');
    const sectionSurfaces = new Set(
      section.visibility.matrix.map((row) => row.surface),
    );
    facts.push({
      ...base,
      factId: `scope:${section.key}:surfaces`,
      section: section.key,
      metric: 'captured_surfaces',
      numerator: sectionSurfaces.size,
      denominator: null,
      unit: 'count',
      sentence: `For ${config.brand.name}'s ${market} audit section, only surfaces with captured answers are included here. ${capturedSurfaceNames(sectionSurfaces, labels)} This section's captured surfaces can differ from other sections or the planned audit scope.`,
    });
    facts.push({
      ...base,
      factId: `scope:${section.key}:questions`,
      section: section.key,
      metric: 'configured_questions',
      numerator: configured.prompts.length,
      denominator: null,
      unit: 'count',
      sentence: `This audit tested ${config.brand.name} in the ${market} section using these questions: ${JSON.stringify(configured.prompts.map(({ text }) => text))}. These are the configured audit questions, not measured search demand or verified customer conversations. Locale: ${config.geography}, language: ${config.language}.`,
    });
    for (const group of ['chat', 'agents'] as const) {
      const surfaces = section.visibility.surfaces.filter(
        (surface) => isAgentSurface(surface) === (group === 'agents'),
      );

      if (!surfaces.length) {
        continue;
      }

      const rows = section.visibility.matrix.filter((row) =>
        surfaces.includes(row.surface),
      );
      const denominator = plannedProbeUnitsForSection({
        sectionKey: section.key,
        prompts: configured.prompts,
        surfaces,
        agentProbes: config.agentProbes,
        chatProbes: config.chatProbes,
      }).length;
      const names =
        group === 'agents' ? 'coding agents' : 'chat and search assistants';
      const entities = [
        { ...config.brand, prospect: true },
        ...(configured.competitors ?? config.competitors).map((brand) => ({
          ...brand,
          prospect: false,
        })),
      ];

      for (const entity of entities) {
        const count = rows.filter((row) =>
          entity.prospect
            ? row.prospectMentioned
            : row.competitors.some(
                (competitor) =>
                  competitor.domain === entity.domain && competitor.mentioned,
              ),
        ).length;
        facts.push({
          ...base,
          factId: `market:${section.key}:${group}:${entity.prospect ? 'brand' : entity.domain}:mentions`,
          section: section.key,
          entity: entity.name,
          metric: 'sample_mentions',
          numerator: count,
          denominator,
          unit: 'planned_answers',
          sentence: `In the ${market} questions in this audit, ${names} mentioned ${entity.name} in ${count} of ${denominator} planned answers. ${rows.length} answers were captured across ${surfaces.join(', ')}. This is visibility within the tested questions and surfaces, not population market share, product quality or a historical trend.`,
        });
      }
    }
  }

  return facts;
};
