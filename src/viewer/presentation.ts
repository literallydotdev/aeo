import { z } from 'zod';
import { aeoFinalCopyDraftSchema } from '../agents/copy-schema';
import { bundlePaths } from '../bundle/contracts';
import { parseBundleJson } from '../bundle/json';
import { capturedRecordsSchema } from '../codex-workflow/run-inputs';
import { intervalPercents } from '../report/core/rate-interval';
import {
  formatReportDate,
  reportSectionTitle,
} from '../report/core/report-presentation';
import {
  aeoPerceptionSchema,
  aeoSnapshotSchema,
  aeoSourceMixSchema,
  brandSchema,
  sourceCategories,
  type AeoMatrixRow,
  type AeoPerception,
  type AeoRateEvidence,
  type AeoSnapshot,
  type AeoSourceMix,
  type AeoVisibility,
  type SourceMixCounts,
} from '../report/core/schema';
import {
  isAgentSurface,
  surfaceFamilyOf,
  surfaceLabels,
} from '../report/core/surfaces';
import { rankAlternatives, type RankedAlternative } from './alternatives';
import { groupCitedDomains, type CitedDomain } from './cited-domains';

// ============================================================================
// What the local viewer shows, derived from a bundle's own documents: the
// hosted report's figures and tables (scorecards, the prompt by surface
// matrix, alternatives, cited domains), computed here in typed code so the
// page's script only renders them. Everything in a bundle is untrusted: each
// document is parsed with its contract, and every string reaches the page as
// data the page inserts as text.
// ============================================================================

// The parts of a snapshot the page shows, each read with its contract; the
// rest is not read. A bundle an earlier release exported may lack the brand
// or the counts: the brand then comes from the audit config, and the counts
// from the matrix.
const viewedSnapshotSchema = z.object({
  brand: brandSchema.optional(),
  sections: aeoSnapshotSchema.shape.sections,
  sourceMix: aeoSourceMixSchema.optional(),
  perception: aeoPerceptionSchema.optional(),
  meta: aeoSnapshotSchema.shape.meta
    .pick({
      generatedAt: true,
      promptCount: true,
      probeCount: true,
      partialFailures: true,
      surfaceLabels: true,
      methodology: true,
      reusedProbes: true,
    })
    .partial({ promptCount: true, probeCount: true, partialFailures: true }),
});

const configBrandSchema = z.object({
  brand: z.object({ name: z.string().min(1), domain: z.string().min(1) }),
});

type Brand = { name: string; domain: string };

export type IntervalView = {
  text: string;
  /** The interval named for a screen reader, which reaches it alone. */
  label: string;
  counts: string;
};

export type RateView = { percent: string; interval?: IntervalView };

export type ScorecardView = {
  headline: string;
  headlineInterval?: IntervalView;
  label: string;
  detail?: string;
  detailInterval?: IntervalView;
};

export type RunView = {
  runNumber: number;
  surface: string;
  cliVersion?: string;
  status: 'primary' | 'mentioned' | 'absent' | 'no_overview';
  retrieval?: 'searched' | 'memory' | 'unknown';
  snippet?: string;
  /** The captured answer, when the bundle holds it. */
  answer?: string;
  mentionedBrands: string[];
  citedUrls: string[];
};

export type CellView = {
  status: 'no_data' | 'absent' | 'primary' | 'mentioned';
  mentioned: number;
  runs: RunView[];
};

export type SectionView = {
  key: string;
  title: string;
  scorecards: ScorecardView[];
  surfaceRates: Array<{
    surface: string;
    shareOfVoice: RateView;
    citationRate: RateView;
  }>;
  matrix: {
    assistantSurfaces: string[];
    agentSurfaces: string[];
    rows: Array<{ prompt: string; category: string; cells: CellView[] }>;
  };
  alternatives: Array<{
    name: string;
    domain?: string;
    share: number;
    percent: string;
    mentioning: number;
    captured: number;
  }>;
  citedDomains: CitedDomain[];
  sourceMix?: {
    rows: Array<{ surface: string; counts: SourceMixCounts }>;
    total: SourceMixCounts;
  };
  perception?: {
    positive: number;
    neutral: number;
    negative: number;
    phrases: Array<{ text: string; count: number; surfaces: string[] }>;
  };
};

export type ReportPresentation =
  | {
      outcome: 'shown';
      brand: { name: string; domain: string };
      hero: {
        title: string;
        subtitle: string;
        measuredOn: string;
        probeCount: number;
        facts: string[];
      };
      intro?: { heading: string; lead: string };
      sections: SectionView[];
      footer: { baseline: string; methodology: string[]; notes: string[] };
    }
  | { outcome: 'missing' }
  | { outcome: 'unreadable'; reason: string };

/** presentReport derives the page's report from a bundle's files. */
export const presentReport = (
  files: ReadonlyMap<string, Buffer>,
): ReportPresentation => {
  const snapshotFile = files.get(bundlePaths.snapshot);

  if (snapshotFile === undefined) {
    return { outcome: 'missing' };
  }

  const snapshot = parseDocument(snapshotFile, viewedSnapshotSchema);

  if (snapshot === undefined) {
    return {
      outcome: 'unreadable',
      reason: `${bundlePaths.snapshot} does not match the report contract of this release.`,
    };
  }

  const brand =
    snapshot.brand ??
    parseDocument(files.get(bundlePaths.config), configBrandSchema)?.brand;

  if (brand === undefined) {
    return {
      outcome: 'unreadable',
      reason: `Neither ${bundlePaths.snapshot} nor ${bundlePaths.config} names the audited brand.`,
    };
  }

  const copy = parseDocument(
    files.get(bundlePaths.copy),
    aeoFinalCopyDraftSchema,
  );
  const captured = parseDocument(
    files.get(bundlePaths.captures),
    capturedRecordsSchema,
  );
  const answers = new Map(
    (captured ?? []).map((record) => [answerKey(record), record.probe.text]),
  );
  const { meta } = snapshot;
  const measuredOn = measurementPeriod(meta);
  const labelOf = surfaceLabelFor(meta.surfaceLabels ?? {});
  const visibilities = snapshot.sections.map((s) => s.visibility);
  const surfaces = [...new Set(visibilities.flatMap((v) => v.surfaces))];
  // A snapshot from before the counts were recorded: every analysed answer
  // is one matrix row, so the count never exceeds what was captured.
  const promptCount =
    meta.promptCount ??
    visibilities.reduce((sum, v) => sum + v.prompts.length, 0);
  const probeCount =
    meta.probeCount ??
    visibilities.reduce((sum, v) => sum + v.matrix.length, 0);
  const presentation: ReportPresentation = {
    outcome: 'shown',
    brand: { name: brand.name, domain: brand.domain },
    hero: {
      title: copy?.hero.title.text ?? `How AI engines see ${brand.name}`,
      subtitle:
        copy?.hero.subtitle.text ??
        defaultSubtitle(brand.name, surfaces, labelOf),
      measuredOn,
      probeCount,
      facts: [
        `${promptCount} buyer-style prompts`,
        `${surfaces.length} AI surfaces${surfaces.some(isAgentSurface) ? ', coding agents included' : ''}`,
        // Only when the bundle holds them: a redaction can withhold them all.
        ...(answers.size > 0 ? ['Raw answers preserved and inspectable'] : []),
      ],
    },
    ...(copy?.intro[0] !== undefined && {
      intro: {
        heading: `How AI engines see ${brand.name}`,
        lead: copy.intro[0].text,
      },
    }),
    sections: snapshot.sections.map((section) =>
      presentSection(section, {
        brand,
        sourceMix: snapshot.sourceMix?.sections.find(
          (s) => s.key === section.key,
        ),
        perception: snapshot.perception?.sections.find(
          (s) => s.key === section.key,
        ),
        labelOf,
        answers,
      }),
    ),
    footer: {
      baseline: `Measured ${measuredOn}: ${promptCount} prompts, ${probeCount} captured answers across ${listOf(surfaces.map(labelOf))}.`,
      methodology: meta.methodology ?? [],
      notes: [
        ...reusedNote(meta.reusedProbes),
        ...unanalyzedNote(meta.partialFailures ?? []),
      ],
    },
  };

  return presentation;
};

type SectionContext = {
  brand: Brand;
  sourceMix: AeoSourceMix['sections'][number] | undefined;
  perception: AeoPerception['sections'][number] | undefined;
  labelOf: (surface: string) => string;
  answers: ReadonlyMap<string, string>;
};

const presentSection = (
  { key, visibility }: AeoSnapshot['sections'][number],
  { brand, sourceMix, perception, labelOf, answers }: SectionContext,
): SectionView => {
  const alternatives = rankAlternatives(visibility.matrix, brand);
  const assistantSurfaces = visibility.surfaces.filter(
    (s) => !isAgentSurface(s),
  );
  const agentSurfaces = visibility.surfaces.filter(isAgentSurface);
  const runViewOf = (row: AeoMatrixRow, index: number): RunView => {
    const answer =
      row.runIndex === undefined
        ? undefined
        : answers.get(
            answerKey({
              sectionKey: key,
              promptText: visibility.prompts[row.promptIdx]?.text ?? '',
              surface: row.surface,
              runIndex: row.runIndex,
            }),
          );

    return presentRun(row, {
      runNumber: row.runIndex ?? index + 1,
      label: labelOf(row.surface),
      answer,
    });
  };
  const section: SectionView = {
    key,
    title: reportSectionTitle(key.replace(/_/g, ' ')),
    scorecards: presentScorecards(visibility, alternatives[0], labelOf),
    surfaceRates: visibility.surfaces.flatMap((surface) => {
      const rates = visibility.summary.byModel[surface];
      const name = labelOf(surface);

      // A rate without its counts (calculation version 1) has no row, as
      // on the hosted report.
      return rates?.shareOfVoiceEvidence === undefined
        ? []
        : [
            {
              surface: name,
              shareOfVoice: rateOf(
                rates.shareOfVoice,
                rates.shareOfVoiceEvidence,
                { subject: `${name} share of voice`, counted: 'Mentioned' },
              ),
              citationRate: rateOf(
                rates.citationRate,
                rates.citationRateEvidence,
                { subject: `${name} citation rate`, counted: 'Cited' },
              ),
            },
          ];
    }),
    matrix: {
      assistantSurfaces: assistantSurfaces.map(labelOf),
      agentSurfaces: agentSurfaces.map(labelOf),
      rows: visibility.prompts.map((prompt, promptIdx) => ({
        prompt: prompt.text,
        category: prompt.category.replace(/_/g, ' '),
        cells: [...assistantSurfaces, ...agentSurfaces].map((surface) =>
          presentCell(
            visibility.matrix
              .filter(
                (row) => row.promptIdx === promptIdx && row.surface === surface,
              )
              .map(runViewOf),
          ),
        ),
      })),
    },
    alternatives: alternatives.slice(0, 10).map((alternative) => {
      const share = alternative.mentioning / alternative.captured;

      return { ...alternative, share, percent: percentOf(share) };
    }),
    citedDomains: groupCitedDomains(visibility, brand.domain).map((domain) => ({
      ...domain,
      urls: domain.urls.map((url) => ({
        ...url,
        surfaces: url.surfaces.map(labelOf),
      })),
    })),
    ...(sourceMix !== undefined && {
      sourceMix: {
        rows: sourceMix.perSurface
          .filter(({ counts }) =>
            sourceCategories.some((category) => counts[category] > 0),
          )
          .map(({ surface, counts }) => ({
            surface: labelOf(surface),
            counts,
          })),
        total: sourceMix.total,
      },
    }),
    ...(perception !== undefined && {
      perception: {
        ...perception.sentiment,
        phrases: groupPhrases(perception.narratives, labelOf),
      },
    }),
  };

  return section;
};

const presentScorecards = (
  visibility: AeoVisibility,
  topAlternative: RankedAlternative | undefined,
  labelOf: (surface: string) => string,
): ScorecardView[] => {
  const { summary } = visibility;
  const namesOf = (family: 'chat' | 'consumer' | 'agents') =>
    listOf(
      visibility.surfaces
        .filter((s) => surfaceFamilyOf(s) === family)
        .map(labelOf),
    );
  // A null rate is a scope the run did not measure: no tile, never a 0%.
  const familyCard = (
    family: 'chat' | 'consumer' | 'agents',
    scope: string,
    rates: {
      shareOfVoice: number | null | undefined;
      citationRate: number | null | undefined;
      shareOfVoiceEvidence: AeoRateEvidence | undefined;
      citationRateEvidence: AeoRateEvidence | undefined;
    },
  ): ScorecardView[] => {
    if (rates.shareOfVoice === null || rates.shareOfVoice === undefined) {
      return [];
    }

    const headline = rateOf(rates.shareOfVoice, rates.shareOfVoiceEvidence, {
      subject: `share of voice across ${scope}`,
      counted: 'Mentioned',
    });
    const detail = rateOf(rates.citationRate ?? 0, rates.citationRateEvidence, {
      subject: `citation rate across ${scope}`,
      counted: 'Cited',
    });
    const card = {
      headline: headline.percent,
      ...(headline.interval !== undefined && {
        headlineInterval: headline.interval,
      }),
      label: `Share of voice — ${scope}`,
      detail: `${detail.percent} citation rate across ${namesOf(family)}`,
      ...(detail.interval !== undefined && { detailInterval: detail.interval }),
    };

    return [card];
  };
  // Measured prompt by surface cells in which no run named the brand.
  const cellMentions = new Map<string, boolean>();

  for (const row of visibility.matrix) {
    const cell = `${row.promptIdx}:${row.surface}`;

    cellMentions.set(
      cell,
      (cellMentions.get(cell) ?? false) || row.prospectMentioned,
    );
  }

  const absentCells = [...cellMentions.values()].filter(
    (mentioned) => !mentioned,
  ).length;
  const scorecards = [
    ...familyCard('chat', 'AI assistants', {
      shareOfVoice: summary.prospectShareOfVoice,
      citationRate: summary.prospectCitationRate,
      shareOfVoiceEvidence: summary.prospectShareOfVoiceEvidence,
      citationRateEvidence: summary.prospectCitationRateEvidence,
    }),
    ...familyCard('consumer', 'consumer apps', {
      shareOfVoice: summary.consumerShareOfVoice,
      citationRate: summary.consumerCitationRate,
      shareOfVoiceEvidence: summary.consumerShareOfVoiceEvidence,
      citationRateEvidence: summary.consumerCitationRateEvidence,
    }),
    ...familyCard('agents', 'coding agents', {
      shareOfVoice: summary.agentShareOfVoice,
      citationRate: summary.agentCitationRate,
      shareOfVoiceEvidence: summary.agentShareOfVoiceEvidence,
      citationRateEvidence: summary.agentCitationRateEvidence,
    }),
    ...(topAlternative === undefined
      ? []
      : [
          {
            headline: percentOf(
              topAlternative.mentioning / topAlternative.captured,
            ),
            label: `${topAlternative.name} share of voice`,
            detail: `Named most often: ${topAlternative.mentioning} of ${topAlternative.captured} captured answers`,
          },
        ]),
    {
      headline: `${absentCells}/${cellMentions.size}`,
      label: 'Cells with zero mentions',
      detail: 'Prompts and surfaces where the brand was absent',
    },
  ];

  return scorecards;
};

const presentRun = (
  row: AeoMatrixRow,
  {
    runNumber,
    label,
    answer,
  }: { runNumber: number; label: string; answer: string | undefined },
): RunView => {
  const mentionedBrands = [
    ...new Set(
      (row.mentionedBrands ?? []).map((brand) => brand.domain ?? brand.name),
    ),
  ];
  const run: RunView = {
    runNumber,
    surface: label,
    ...(row.agentCliVersion !== undefined && {
      cliVersion: row.agentCliVersion,
    }),
    status: statusOf(row),
    ...(row.usedWebSearch !== undefined && {
      retrieval: retrievalOf(row.usedWebSearch),
    }),
    ...(row.contextSnippet !== null && { snippet: row.contextSnippet }),
    ...(answer !== undefined && { answer }),
    mentionedBrands,
    citedUrls: row.citedUrls ?? [],
  };

  return run;
};

// Agent runs only. Null is a stream that could not be read: retrieval is
// unknown, never either measured state.
const retrievalOf = (
  usedWebSearch: boolean | null,
): NonNullable<RunView['retrieval']> => {
  if (usedWebSearch === null) {
    return 'unknown';
  }

  return usedWebSearch ? 'searched' : 'memory';
};

const statusOf = (row: AeoMatrixRow): RunView['status'] => {
  // A results page without an AI Overview: no answer to be absent from.
  if (row.noOverview) {
    return 'no_overview';
  }

  if (!row.prospectMentioned) {
    return 'absent';
  }

  return row.prospectPosition === 'primary' ? 'primary' : 'mentioned';
};

const presentCell = (runs: RunView[]): CellView => {
  const mentioned = runs.filter(
    (run) => run.status === 'primary' || run.status === 'mentioned',
  ).length;

  if (runs.length === 0) {
    return { status: 'no_data', mentioned, runs };
  }

  if (mentioned === 0) {
    return { status: 'absent', mentioned, runs };
  }

  const status = runs.some((run) => run.status === 'primary')
    ? 'primary'
    : 'mentioned';

  return { status, mentioned, runs };
};

const rateOf = (
  rate: number,
  evidence: AeoRateEvidence | undefined,
  {
    subject,
    counted,
  }: {
    /** The rate named for a screen reader. */
    subject: string;
    /** What the count counts: answers that mentioned, or that cited. */
    counted: 'Mentioned' | 'Cited';
  },
): RateView => {
  const percent = percentOf(rate);

  // A bundle is shown even when it fails verification: bounds that are out
  // of order are not an interval.
  if (evidence === undefined || evidence.low > evidence.high) {
    return { percent };
  }

  const { low, high } = intervalPercents(evidence);
  const text = `approx. 95% interval ${low}–${high}%`;
  const view = {
    percent,
    interval: {
      text,
      label: `${text} for ${subject}`,
      counts: `${counted} in ${evidence.count} of ${evidence.planned} planned answers; ${evidence.captured} captured`,
    },
  };

  return view;
};

const groupPhrases = (
  narratives: ReadonlyArray<{ phrase: string; surface: string }>,
  labelOf: (surface: string) => string,
) => {
  const byPhrase = new Map<
    string,
    { text: string; count: number; surfaces: string[] }
  >();

  for (const narrative of narratives) {
    const text = narrative.phrase.trim();
    const key = text.toLowerCase();

    if (key === '') {
      continue;
    }

    const entry = byPhrase.get(key) ?? { text, count: 0, surfaces: [] };
    const surface = labelOf(narrative.surface);

    entry.count += 1;
    if (!entry.surfaces.includes(surface)) {
      entry.surfaces.push(surface);
    }
    byPhrase.set(key, entry);
  }

  const phrases = [...byPhrase.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return phrases;
};

/** The run's own label first (a custom surface, or one asked of another
 * model); otherwise the engine's, without "(API)", as the hosted report
 * names them. The methodology sentences say how each surface was asked. */
const surfaceLabelFor =
  (runLabels: Readonly<Record<string, string>>) =>
  (surface: string): string => {
    return (
      runLabels[surface] ??
      surfaceLabels[surface]?.replace(/ \(API\)$/, '') ??
      surface
    );
  };

const defaultSubtitle = (
  brandName: string,
  surfaces: readonly string[],
  labelOf: (surface: string) => string,
): string => {
  const assistants = surfaces.filter((s) => !isAgentSurface(s)).map(labelOf);
  const agents = surfaces.filter(isAgentSurface).map(labelOf);
  const asked =
    assistants.length > 0
      ? `How often ${listOf(assistants)} mention and cite ${brandName}.`
      : `How often AI answers mention and cite ${brandName}.`;
  const subtitle =
    agents.length > 0
      ? `${asked} Plus ${agents.length === 1 ? 'one coding agent' : `${agents.length} coding agents`}: ${listOf(agents)}.`
      : asked;

  return subtitle;
};

type ReusedProbes = NonNullable<AeoSnapshot['meta']['reusedProbes']>;

// A run that reused earlier captures mixes their ages: the date the report
// was generated would, alone, overstate how fresh its answers are.
const measurementPeriod = ({
  generatedAt,
  reusedProbes,
}: {
  generatedAt: string;
  reusedProbes?: ReusedProbes;
}): string => {
  const generated = formatReportDate(generatedAt);

  if (reusedProbes === undefined) {
    return generated;
  }

  return reusedProbes.oldestCapturedAt === null
    ? `by ${generated}`
    : `${formatReportDate(reusedProbes.oldestCapturedAt)} to ${generated}`;
};

const reusedNote = (reusedProbes: ReusedProbes | undefined): string[] => {
  if (reusedProbes === undefined) {
    return [];
  }

  const { count } = reusedProbes;

  return [
    `${count} answer${count === 1 ? ' was' : 's were'} reused from an earlier capture, not asked again by this run.`,
  ];
};

// A prompt whose analysis failed is left out of the matrix and recorded as
// `analysis:search:<section>:<prompt>`.
const unanalyzedNote = (
  partialFailures: ReadonlyArray<{ step: string }>,
): string[] => {
  const count = partialFailures.filter((f) =>
    f.step.startsWith('analysis:search:'),
  ).length;

  if (count === 0) {
    return [];
  }

  return [
    `${count} prompt${count === 1 ? '' : 's'} could not be analyzed in this run and show${count === 1 ? 's' : ''} as no data.`,
  ];
};

/** A captured answer's identity: its section, question, surface and run. */
const answerKey = ({
  sectionKey,
  promptText,
  surface,
  runIndex,
}: {
  sectionKey: string;
  promptText: string;
  surface: string;
  runIndex: number;
}): string => {
  return JSON.stringify([sectionKey, promptText, surface, runIndex]);
};

const percentOf = (share: number): string => {
  return `${(share * 100).toFixed(0)}%`;
};

const listOf = (names: readonly string[]): string => {
  const unique = [...new Set(names)];

  if (unique.length <= 1) {
    return unique[0] ?? 'the measured surfaces';
  }

  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1) ?? ''}`;
};

/** A bundle document read with its contract; undefined when the document
 * is absent (withheld included), is not JSON, repeats a key or does not
 * match. */
const parseDocument = <Document>(
  file: Buffer | undefined,
  schema: z.ZodType<Document>,
): Document | undefined => {
  if (file === undefined) {
    return undefined;
  }

  try {
    const parsed = schema.safeParse(parseBundleJson(file.toString('utf8')));

    return parsed.success ? parsed.data : undefined;
  } catch {
    // Text that is not JSON, or JSON with a duplicate key.
    return undefined;
  }
};
