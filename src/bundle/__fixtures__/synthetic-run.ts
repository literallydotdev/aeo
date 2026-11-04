import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCaptureManifest, capturePlan } from '../../capture-manifest';
import { aggregateWorkdir } from '../../codex-workflow/aggregate';
import { runInputsFile, type RunInputs } from '../../codex-workflow/run-inputs';
import { answerFilePath } from '../../codex-workflow/workdir';
import type { CaptureArtifact } from '../../harness/report/artifacts';
import { unitRecordKey } from '../../lib/checkpoint';
import {
  aeoAuditConfigSchema,
  runRequestSchema,
  type AeoSurface,
} from '../../schema';
import { contentHash } from '../../stores/content-hash';
import type { CapturedUnitRecord } from '../../stores/ports';

// A fictional, fully local run: two sections (one with a key no bundle path
// could carry), two chat surfaces, one failed slot and one unjudged answer.
// The aggregate, metrics and snapshot come from the workflow's own
// aggregate step, so the verifier recomputes what production would write.

export const syntheticRunId = '01M2SYNTHET1CRVNAAAAAAAAAA';
export const syntheticReportKey = 'synthetic-bundle';
export const oddSectionKey = 'Märkte/../Éditeurs';

const surfaces: AeoSurface[] = ['chatgpt', 'perplexity'];

export const syntheticConfig = aeoAuditConfigSchema.parse({
  reportKey: syntheticReportKey,
  slug: 'synthetic-bundle-abcde',
  brand: { name: 'Acmebase', domain: 'acmebase.test', aliases: [] },
  competitors: [
    { name: 'Rivalstack', domain: 'rivalstack.test' },
    { name: 'Othertool', domain: 'othertool.test' },
  ],
  sections: [
    {
      key: 'hosting',
      prompts: [
        {
          id: 'h1',
          text: 'Which hosted databases suit a small team?',
          category: 'product_recommendation',
        },
        {
          id: 'h2',
          text: 'What is the cheapest managed database?',
          category: 'product_recommendation',
        },
      ],
    },
    {
      key: oddSectionKey,
      prompts: [
        {
          id: 'm1',
          text: 'Which database vendors serve publishers?',
          category: 'product_recommendation',
        },
      ],
    },
  ],
  moneyPages: ['https://acmebase.test/docs'],
  productBrief: 'A fictional database product used only in tests.',
});

const answerText = (index: number): string => {
  if (index % 3 === 0) {
    return 'Acmebase is the simplest choice for small teams (https://acmebase.test/docs). Rivalstack is a solid alternative.';
  }

  if (index % 3 === 1) {
    return 'Rivalstack leads here; Othertool is cheaper. See https://rivalstack.test/pricing.';
  }

  return 'Most teams pick Othertool for price. Rivalstack is another option.';
};

export type SyntheticRun = {
  dir: string;
  captured: CapturedUnitRecord[];
  failedSlot: string;
  unjudgedFile: string;
};

export const createSyntheticRun = async (
  dir: string,
  { answerOverride }: { answerOverride?: string } = {},
): Promise<SyntheticRun> => {
  const plan = capturePlan(syntheticConfig, surfaces);
  const [failedUnit, ...capturedUnits] = plan.units;

  if (!failedUnit) {
    throw new Error('The synthetic plan has no units.');
  }

  const captured = capturedUnits.map((unit, index): CapturedUnitRecord => ({
    status: 'captured',
    ...unit,
    runId: syntheticRunId,
    capturedAt: '2026-11-01T10:00:00.000Z',
    probe: {
      promptId: unit.promptId,
      promptText: unit.promptText,
      promptCategory: 'product_recommendation',
      modelName: unit.surface,
      runIndex: unit.runIndex,
      text:
        index === 0 && answerOverride !== undefined
          ? answerOverride
          : answerText(index),
    },
    captureMetadata: {
      requestedModel: `${unit.surface}-model`,
      reportedModel: index % 2 === 0 ? `${unit.surface}-model-2026` : null,
      parameters: {},
    },
  }));

  const capture: CaptureArtifact = {
    version: 1,
    reportKey: syntheticReportKey,
    runId: syntheticRunId,
    planDigest: contentHash(plan.units.map(unitRecordKey)),
    plannedUnits: plan.units.length,
    surfaces,
    sections: Object.fromEntries(
      syntheticConfig.sections.map((section) => {
        const records = captured.filter(
          (record) => record.sectionKey === section.key,
        );

        return [
          section.key,
          {
            units: records.map((record) => ({
              unitKey: unitRecordKey(record),
              promptId: record.promptId,
              surface: record.surface,
              runIndex: record.runIndex,
              rawDigest: contentHash(record.probe.text),
              capturedAt: record.capturedAt,
            })),
            coverage: surfaces.map((surface) => ({
              surface,
              planned: plan.units.filter(
                (unit) =>
                  unit.sectionKey === section.key && unit.surface === surface,
              ).length,
              captured: records.filter((record) => record.surface === surface)
                .length,
            })),
            lostPromptIds: [],
            unitFailures:
              failedUnit.sectionKey === section.key
                ? [
                    {
                      promptId: failedUnit.promptId,
                      surface: failedUnit.surface,
                      runIndex: failedUnit.runIndex,
                      kind: 'capacity',
                      attempts: 3,
                    },
                  ]
                : [],
            rejectedWebToolSurfaces: [],
            freshChatRetrieval: [],
            freshAgentRetrieval: [],
          },
        ];
      }),
    ),
    failedSections: [],
    resumed: { count: 0, total: plan.units.length, oldestCapturedAt: null },
    agentCliVersions: { claudeCode: null, codex: null, cursor: null },
    startedAt: '2026-11-01T09:00:00.000Z',
    completedAt: '2026-11-01T10:00:00.000Z',
  };

  const request = runRequestSchema.parse({
    reportKey: syntheticReportKey,
    runId: syntheticRunId,
  });
  const inputs: RunInputs = {
    version: 1,
    reportKey: syntheticReportKey,
    runId: syntheticRunId,
    config: syntheticConfig,
    request,
    surfaces,
    capture,
    captured,
  };

  await mkdir(path.join(dir, 'OUT'), { recursive: true });
  await writeFile(path.join(dir, runInputsFile), JSON.stringify(inputs));

  const files = captured.map(answerFilePath);
  const [unjudgedFile, ...judgedFiles] = files;

  if (unjudgedFile === undefined) {
    throw new Error('The synthetic run captured nothing.');
  }

  const analyze = {
    rows: judgedFiles.map((file, index) => {
      const mentioned = (index + 1) % 3 === 0;

      return {
        file,
        prospectMentioned: mentioned,
        prospectPosition: mentioned ? 'primary' : 'absent',
        prospectSentiment: mentioned ? 'positive' : 'neutral',
        contextSnippet: mentioned
          ? 'Acmebase is the simplest choice for small teams'
          : '',
        competitorMentions: [
          { domain: 'rivalstack.test', mentioned: true, position: 'secondary' },
          {
            domain: 'othertool.test',
            mentioned: index % 2 === 0,
            position: 'listed',
          },
        ],
        mentionedBrands: [{ name: 'Rivalstack', domain: 'rivalstack.test' }],
      };
    }),
  };
  const qualify = {
    rows: judgedFiles.map((file) => ({
      file,
      qualifiedCompetitors: [
        { name: 'Rivalstack', domain: 'rivalstack.test', quote: 'Rivalstack' },
      ],
    })),
    corrections: [],
  };

  await writeFile(
    path.join(dir, 'OUT', 'analyze.json'),
    JSON.stringify(analyze),
  );
  await writeFile(
    path.join(dir, 'OUT', 'qualify.json'),
    JSON.stringify(qualify),
  );
  await writeFile(
    path.join(dir, 'OUT', 'corrections.json'),
    JSON.stringify([]),
  );

  const aggregate = await aggregateWorkdir({
    dir,
    config: syntheticConfig,
    surfaces,
    capture,
    captured,
  });
  const chunks = Object.values(aggregate.sections).flatMap(
    (section) => section.evidenceChunks,
  );
  const captureManifest = buildCaptureManifest({
    reportKey: syntheticReportKey,
    runId: syntheticRunId,
    createdAt: '2026-11-01T10:30:00.000Z',
    config: syntheticConfig,
    chunks,
    records: captured,
    surfaces,
  });
  const snapshot = {
    version: 2,
    reportKey: syntheticReportKey,
    sections: Object.entries(aggregate.sections).map(([key, section]) => ({
      key,
      visibility: section.visibility,
    })),
    meta: {
      generatedAt: '2026-11-01T10:30:00.000Z',
      analyzerVersion: 'codex-v1',
    },
  };

  await writeFile(
    path.join(dir, 'OUT', 'capture-manifest.json'),
    JSON.stringify(captureManifest),
  );
  await writeFile(
    path.join(dir, 'OUT', 'snapshot.json'),
    JSON.stringify(snapshot),
  );

  return {
    dir,
    captured,
    failedSlot: unitRecordKey(failedUnit),
    unjudgedFile,
  };
};
