import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  extractCitedUrls,
  normalizeResponseText,
} from '../analysis/answer-text';
import { isDomainCited } from '../analysis/domain-match';
import { normalizeDomain } from '../analysis/scoring';
import type { CaptureArtifact } from '../harness/report/artifacts';
import type {
  AnalyzedRun,
  PromptAnalysisResult,
  SectionRunResult,
} from '../pipeline';
import {
  calculationVersion,
  readableCalculationVersions,
  type CalculationVersion,
} from '../bundle/contracts';
import { assembleSectionResult } from '../section-result';
import type { AeoAuditConfig, AeoSurface } from '../schema';
import type { CapturedUnitRecord } from '../stores/ports';
import { isObject } from '../lib/type-guards';
import {
  analyzeOutputSchema,
  qualifyOutputSchema,
  type AnalyzeOutput,
} from './schemas';
import { canonicalizeQualifiedNames } from './checks';
import { answerFilePath, answerSectionPrefix } from './workdir';

// ============================================================================
// The host's aggregate step (specs/aeo-codex-workflow-spec.md §4, §5): the
// corrected Codex outputs lifted into the pipeline's analyzed-run shape and
// handed to the same section assembly the runner uses, so metrics, share of
// voice, evidence and the matrix are computed by the code that already
// computes them. Citation stays deterministic: it comes from URLs in the
// answer text, never from a stage's judgment.
// ============================================================================

export type AggregateInputs = {
  dir: string;
  config: AeoAuditConfig;
  surfaces: readonly AeoSurface[];
  capture: CaptureArtifact;
  captured: readonly CapturedUnitRecord[];
};

type AggregateResults = {
  sections: Record<string, SectionRunResult>;
  /** Captured answers with no analysis row: a degraded batch. They stay in
   * the coverage counts and out of the matrix. */
  unjudged: string[];
};

/** OUT/aggregate.json. Version 1 was computed with calculation version 1
 * and names none; version 2 records the calculation version its numbers
 * were made with, which the export stamps (method release spec §6.3). */
export type AggregateOutput =
  | ({ version: 1 } & AggregateResults)
  | ({ version: 2; calculationVersion: CalculationVersion } & AggregateResults);

// A section result has no schema of its own; the aggregate file is written
// by aggregateWorkdir below, so the check stops at the parts every reader
// relies on.
const sectionRunResultSchema = z.custom<SectionRunResult>(
  (value) =>
    isObject(value) &&
    isObject(value.visibility) &&
    Array.isArray(value.evidenceChunks),
);

const aggregateResultsShape = {
  sections: z.record(z.string(), sectionRunResultSchema),
  unjudged: z.array(z.string()),
};

const aggregateOutputSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...aggregateResultsShape }),
  z.object({
    version: z.literal(2),
    calculationVersion: z.literal([...readableCalculationVersions]),
    ...aggregateResultsShape,
  }),
]);

/** OUT/aggregate.json as written by aggregateWorkdir. */
export const parseAggregateOutput = (text: string): AggregateOutput => {
  return aggregateOutputSchema.parse(JSON.parse(text));
};

// Only the version fields: an aggregate whose sections are damaged still
// names the version its numbers were made with, and the verifier reports
// the damage.
const recordedVersionSchema = z.discriminatedUnion('version', [
  z.looseObject({ version: z.literal(1) }),
  z.looseObject({
    version: z.literal(2),
    calculationVersion: z.literal([...readableCalculationVersions]),
  }),
]);

/**
 * recordedCalculationVersion is the calculation version a stored aggregate
 * says its numbers were made with; undefined when it names none this
 * release can read.
 */
export const recordedCalculationVersion = (
  value: unknown,
): CalculationVersion | undefined => {
  const recorded = recordedVersionSchema.safeParse(value);

  if (!recorded.success) {
    return undefined;
  }

  return recorded.data.version === 1 ? 1 : recorded.data.calculationVersion;
};

/** A Codex analyze row as the pipeline's analyzed run: the judgment fields
 * from the row, the deterministic fields from the captured probe. */
export type LiftAnalyzedRunOptions = {
  promptIdx: number;
  brand: AeoAuditConfig['brand'];
  competitors: AeoAuditConfig['competitors'];
};

export const liftAnalyzedRun = (
  row: AnalyzeOutput['rows'][number],
  record: CapturedUnitRecord,
  { promptIdx, brand, competitors }: LiftAnalyzedRunOptions,
): AnalyzedRun => {
  const probe = record.probe;
  const citedUrls = extractCitedUrls(probe.text);
  const competitorMentions = competitors.map((competitor) => {
    const domain = normalizeDomain(competitor.domain);
    const judged = row.competitorMentions.find(
      (mention) => normalizeDomain(mention.domain) === domain,
    );

    return {
      domain,
      mentioned: judged?.mentioned ?? false,
      cited: isDomainCited(citedUrls, competitor.domain),
    };
  });

  return {
    promptIdx,
    promptId: record.promptId,
    surface: probe.modelName,
    runIndex: probe.runIndex,
    clientMentioned: row.prospectMentioned,
    clientCited: isDomainCited(citedUrls, brand.domain),
    clientPosition: row.prospectPosition,
    clientSentiment: row.prospectSentiment,
    contextSnippet: row.contextSnippet || null,
    responseText: normalizeResponseText(probe.text),
    citedUrls,
    competitorMentions,
    allMentionedBrands: row.mentionedBrands,
    ...('usedWebSearch' in probe
      ? {
          usedWebSearch: probe.usedWebSearch,
          agentCliVersion: probe.agentCliVersion,
        }
      : {}),
    ...(probe.retrieval ? { retrieval: probe.retrieval } : {}),
    ...(probe.noOverview ? { noOverview: true as const } : {}),
  };
};

/** OUT/analyze.json and OUT/qualify.json, corrections already applied,
 * aggregated per section into the runner's section result. */
export const aggregateWorkdir = async (
  inputs: AggregateInputs,
  // The engine's own: a run directory is measured by one method throughout
  // (src/engine/run-method.ts). Only a fixture of an earlier release's
  // directory passes another.
  version: CalculationVersion = calculationVersion,
): Promise<AggregateOutput> => {
  const { dir, config } = inputs;

  const output = aggregateJudgments(
    inputs,
    {
      analyze: JSON.parse(
        await readFile(path.join(dir, 'OUT', 'analyze.json'), 'utf8'),
      ),
      qualify: JSON.parse(
        await readFile(path.join(dir, 'OUT', 'qualify.json'), 'utf8'),
      ),
    },
    version,
  );

  await writeFile(
    path.join(dir, 'OUT', 'aggregate.json'),
    JSON.stringify(output, null, 2),
  );
  await writeFile(
    path.join(dir, 'METRICS.json'),
    JSON.stringify(metricsView(output, config.brand.domain), null, 2),
  );

  return output;
};

/**
 * aggregateJudgments is the arithmetic of the aggregate step with no file
 * access, so the offline bundle verifier recomputes the published numbers
 * with the code that produced them (specs/aeo-open-source-cli-spec.md §10),
 * at the calculation version they were made with.
 */
export const aggregateJudgments = (
  inputs: Omit<AggregateInputs, 'dir'>,
  judgments: { analyze: unknown; qualify: unknown },
  version: CalculationVersion,
): AggregateOutput => {
  const { config } = inputs;
  // A model batch must cover its answers, but the host may have no accepted
  // judgments at all. Preserve that measurement with empty enrichment.
  const analyze = analyzeOutputSchema
    .extend({ rows: analyzeOutputSchema.shape.rows.element.array() })
    .parse(judgments.analyze);

  const qualify = qualifyOutputSchema.parse(judgments.qualify);
  const rowByFile = new Map(analyze.rows.map((row) => [row.file, row]));
  // Idempotent here as well as at merge time, so a directory qualified
  // before the rule existed gets one name per alternative without a rerun.
  const qualifiedByFile = new Map(
    canonicalizeQualifiedNames(qualify.rows).map((row) => [
      row.file,
      row.qualifiedCompetitors.map(({ name, domain }) => ({ name, domain })),
    ]),
  );

  const recordByFile = new Map(
    inputs.captured.map((record) => [answerFilePath(record), record]),
  );

  const sections: Record<string, SectionRunResult> = {};
  const unjudged: string[] = [];

  for (const section of config.sections) {
    const sectionCapture = inputs.capture.sections[section.key];

    if (!sectionCapture) {
      throw new Error(`Section has no capture to aggregate: ${section.key}.`);
    }

    const competitors = section.competitors ?? config.competitors;
    const analyses: PromptAnalysisResult[] = section.prompts.map(
      (prompt, promptIdx) => {
        const runs: AnalyzedRun[] = [];

        for (const [file, record] of recordByFile) {
          if (
            record.sectionKey !== section.key ||
            record.promptId !== prompt.id
          ) {
            continue;
          }

          const row = rowByFile.get(file);

          if (!row) {
            unjudged.push(file);
            continue;
          }

          runs.push(
            liftAnalyzedRun(row, record, {
              promptIdx,
              brand: config.brand,
              competitors,
            }),
          );
        }

        return { promptId: prompt.id, runs, cached: false, error: null };
      },
    );

    const result = assembleSectionResult(
      {
        sectionKey: section.key,
        brand: config.brand,
        competitors,
        prompts: section.prompts,
        surfaces: inputs.surfaces,
        agentProbes: config.agentProbes,
        chatProbes: config.chatProbes,
        calculationVersion: version,
      },
      {
        probeCount: sectionCapture.units.length,
        coverage: sectionCapture.coverage,
        lostPromptIds: sectionCapture.lostPromptIds,
        unitFailures: sectionCapture.unitFailures,
        rejectedWebToolSurfaces: sectionCapture.rejectedWebToolSurfaces,
        freshChatRetrieval: sectionCapture.freshChatRetrieval,
        freshAgentRetrieval: sectionCapture.freshAgentRetrieval,
      },
      analyses,
    );

    // The qualify stage's judgment lands on the matrix row it is about; an
    // empty list is authoritative (no buyer alternative in that answer).
    for (const row of result.visibility.matrix) {
      const prompt = section.prompts[row.promptIdx];

      if (!prompt) {
        continue;
      }

      const file = answerFilePath({
        sectionKey: section.key,
        promptId: prompt.id,
        surface: row.surface,
        runIndex: row.runIndex ?? 0,
      });

      // No qualify row at all (a degraded batch) keeps the reader's legacy
      // fallback to the mentioned configured competitors; a row with none
      // is authoritative.
      const qualified = qualifiedByFile.get(file);

      if (qualified) {
        row.qualifiedCompetitors = qualified;
      }
    }

    sections[section.key] = result;
  }

  const output: AggregateOutput =
    version === 1
      ? { version: 1, sections, unjudged }
      : { version: 2, calculationVersion: version, sections, unjudged };

  return output;
};

/** What a scrutiny pass reads: the numbers the report will show, per
 * section, small enough to check against the rows by hand. */
export const metricsView = (output: AggregateOutput, brandDomain: string) => {
  return {
    sections: Object.fromEntries(
      Object.entries(output.sections).map(([key, result]) => {
        const { summary, matrix } = result.visibility;
        const counted = matrix.filter((row) => !row.noOverview);

        return [
          key,
          {
            capturedAnswers: counted.length,
            prospectMentioned: counted.filter((row) => row.prospectMentioned)
              .length,
            // Citation is a URL on the brand's domain, never "mentioned and
            // cites something" (the first scrutiny pass caught that count).
            prospectCited: counted.filter((row) =>
              isDomainCited(row.citedUrls ?? [], brandDomain),
            ).length,
            prospectShareOfVoice: summary.prospectShareOfVoice,
            prospectCitationRate: summary.prospectCitationRate,
            agentShareOfVoice: summary.agentShareOfVoice,
            agentCitationRate: summary.agentCitationRate,
            // Calculation version 2's evidence; absent from version 1, so
            // its view keeps its bytes.
            ...(summary.prospectShareOfVoiceEvidence && {
              prospectShareOfVoiceEvidence:
                summary.prospectShareOfVoiceEvidence,
            }),
            ...(summary.prospectCitationRateEvidence && {
              prospectCitationRateEvidence:
                summary.prospectCitationRateEvidence,
            }),
            ...(summary.agentShareOfVoiceEvidence && {
              agentShareOfVoiceEvidence: summary.agentShareOfVoiceEvidence,
            }),
            ...(summary.agentCitationRateEvidence && {
              agentCitationRateEvidence: summary.agentCitationRateEvidence,
            }),
            byModel: summary.byModel,
            byCompetitor: summary.byCompetitor,
            topCompetitorDomain: summary.topCompetitorDomain,
            qualifiedCompetitorCounts: countQualified(matrix),
            lostPromptIds: result.lostPromptIds,
            analysisFailures: result.analysisFailures,
            unjudgedAnswers: output.unjudged.filter((file) =>
              file.startsWith(answerSectionPrefix(key)),
            ),
          },
        ];
      }),
    ),
  };
};

const countQualified = (matrix: SectionRunResult['visibility']['matrix']) => {
  const counts = new Map<string, number>();

  for (const row of matrix) {
    for (const entry of row.qualifiedCompetitors ?? []) {
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, answers]) => ({ name, answers }));
};
