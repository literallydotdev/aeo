import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  domainLabelsFileSchema,
  type DomainLabelsFile,
} from '../analysis/domain-labels';
import {
  buildCaptureManifest,
  captureManifestSchema,
  type CaptureManifest,
} from '../capture-manifest';
import {
  groundingBundleSchema,
  type GroundingBundle,
} from '../grounding/schema';
import type { SectionRunResult } from '../pipeline';
import { buildMethodology } from '../agents/methodology';
import {
  askedModelsOn,
  reportedModelsOn,
  defaultBindingsChosenOn,
  defaultProbeBindings,
  modelBoundSurfaces,
  surfaceLabelOverrides,
} from '../probes/bindings';
import { ProbeLimiter } from '../probes/limits';
import {
  checkRetrievalCapture,
  checkWebToolDetection,
  checkWebToolParse,
  type PartialFailure,
} from '../probes/web-tool-guard';
import { isAgentSurface } from '../schema';
import type { CaptureArtifact } from '../harness/report/artifacts';
import {
  assembleSnapshot,
  enrichSourceMix,
  runPerceptionPass,
} from '../runner';
import {
  aeoSnapshotSchema,
  partialFailureSchema,
  type AeoEvidenceChunk,
  type AeoSnapshot,
} from '../schema';
import { StoreConflictError } from '../stores/versions';
import type { ModelCallAccounting } from '../models/accounting';
import type { InternalModelContext } from '../models/context';
import { parseAggregateOutput, type AggregateOutput } from './aggregate';
import { stageVersions, workflowVersion } from './schemas';
import { hostModels, pinnedProfileOf } from './host-models';
import type { RunSource } from './run-source';
import type { ReportQuality } from './quality';

/** The snapshot's analyzer provenance: the Codex analyze stage under the
 * workflow version, in a number space of its own (the retired in-process
 * analyzer counted 1 to 8), and the run's stage model. */
export const codexAnalyzer = (model: string) => {
  return {
    version: workflowVersion * 100 + stageVersions.analyze,
    model,
  };
};

// ============================================================================
// The finish of a Codex run (specs/aeo-codex-workflow-spec.md §5): the
// accepted, corrected outputs turned into the report the site reads, by the
// runner's own deterministic assembly. The two host model steps the harness
// kept (perception, source labels) run on the configured profile under a
// small memory budget; grounding, when the caller provides it, runs over
// the one capture manifest this step builds. Everything it produces is
// returned and written to the work directory; the database sees one write,
// at the end, only when asked and only while the run's pipeline permits it.
// ============================================================================

export type FinishResult = {
  /** True when the step reused what an earlier run assembled from the
   * same inputs: no model call was made. */
  reused: boolean;
  snapshot: AeoSnapshot;
  labels: DomainLabelsFile;
  captureManifest: CaptureManifest;
  chunks: AeoEvidenceChunk[];
  grounding: GroundingBundle | null;
  partialFailures: PartialFailure[];
  labelStats: Record<string, number>;
  snapshotFile: string;
  written: 'written' | 'refused' | 'skipped';
  writeMessage: string | null;
};

/** Factual grounding over a run's capture manifest. The accounting it is
 * given is the step's own, so a recording run records grounding's calls
 * as it records every other host call. */
export type GroundRun = (
  manifest: CaptureManifest,
  options?: { accounting?: ModelCallAccounting },
) => Promise<GroundingBundle>;

export const finishRun = async (args: {
  source: RunSource;
  dir: string;
  /** Files excluded by degraded batches, recorded as partial failures. */
  degraded: readonly string[];
  write: boolean;
  /** The model ID the Codex stages ran on, the analyzer's provenance. */
  stageModelId: string;
  /** Factual grounding over the run's manifest (the container job); a
   * source that already carries a bundle needs none. */
  ground?: GroundRun;
  internalModels?: InternalModelContext;
  signal?: AbortSignal;
  quality?: ReportQuality;
}): Promise<FinishResult> => {
  const { source, dir, signal } = args;
  const { config, request, plan } = source;
  const aggregateText = await readFile(
    path.join(dir, 'OUT', 'aggregate.json'),
    'utf8',
  );

  const aggregate = parseAggregateOutput(aggregateText);
  // The step's own inputs digest: the perception and label calls are not
  // deterministic, so a resume over unchanged rows must reuse what they
  // produced rather than learn different labels and change the facts the
  // copy was written from.
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        aggregate: aggregateText,
        technical: source.technical,
        grounding: source.grounding,
        runId: request.runId,
        configVersion: request.configVersion,
        degraded: args.degraded,
        ground: Boolean(args.ground),
      }),
    )
    .digest('hex');

  const reused = await reuseFinish(dir, digest, aggregate);

  if (reused) {
    if (args.quality) {
      reused.snapshot.meta.quality = args.quality;
      await writeFile(
        reused.snapshotFile,
        JSON.stringify(reused.snapshot, null, 2),
      );
    }

    return args.write ? writeFinished(source, reused) : reused;
  }

  const completedSections = Object.entries(aggregate.sections).map(
    ([key, result]) => ({
      key,
      result,
    }),
  );

  const partialFailures: PartialFailure[] = [
    ...(source.technical?.failures ?? []),
    ...args.degraded.map((file) => ({
      step: 'codex:degraded',
      error: `${file}: no accepted judgment`,
    })),
    ...aggregate.unjudged.map((file) => ({
      step: 'codex:unjudged',
      error: `${file}: left out of the matrix`,
    })),
  ];

  const internalModels =
    args.internalModels ??
    hostModels(pinnedProfileOf(source.request.modelProfile));
  const logContext = {
    reportKey: config.reportKey,
    runId: request.runId,
    codex: true,
  };

  const chunks = completedSections.flatMap(
    ({ result }) => result.evidenceChunks,
  );
  const createdAt = new Date().toISOString();
  const captureManifest = buildCaptureManifest({
    reportKey: config.reportKey,
    runId: request.runId,
    createdAt,
    config,
    chunks,
    records: [...source.captured],
    surfaces: plan.surfaces,
    sections: request.sections,
  });

  const grounding = args.ground
    ? await args.ground(captureManifest, {
        accounting: internalModels.accounting,
      })
    : source.grounding;

  const perceptionPass = await runPerceptionPass(config, completedSections, {
    analysisStore: source.stores.analysisStore,
    runId: request.runId,
    limiter: new ProbeLimiter(request.limits),
    signal,
    internalModels,
  });

  partialFailures.push(...perceptionPass.failures);

  const enriched = await enrichSourceMix(
    config,
    completedSections.map(({ key, result }) => ({
      key,
      visibility: result.visibility,
    })),
    {
      previousLabels: await source.stores.reportStore.readLabels(
        config.reportKey,
      ),
      logContext,
      internalModels,
      signal,
    },
  );

  for (const failure of enriched.labels.failures) {
    partialFailures.push({ step: 'domain_labels:model', error: failure });
  }

  partialFailures.push(
    ...webToolGuardFailures(source.capture, completedSections),
  );

  if (!source.technical?.checks) {
    partialFailures.push({
      step: 'technical_checks',
      error: 'the run carries no technical checks',
    });
  }

  const surfaceLabels = surfaceLabelOverrides(
    source.captured,
    config.customSurfaces,
  );
  const snapshot = assembleSnapshot({
    config,
    request,
    plan,
    completedSections,
    enriched,
    perception: perceptionPass.perception,
    checks: source.technical?.checks ?? undefined,
    agentCliVersions: source.capture.agentCliVersions,
    resumed: source.capture.resumed,
    promptCount: plan.promptCount,
    probeCount: completedSections.reduce(
      (total, { result }) => total + result.probeCount,
      0,
    ),
    partialFailures,
    generatedAt: createdAt,
    analyzer: codexAnalyzer(args.stageModelId),
    surfaceLabels,
    methodology: buildMethodology({
      surfaces: plan.surfaces,
      askedModels: Object.fromEntries(
        modelBoundSurfaces.map((surface) => [
          surface,
          askedModelsOn(source.captured, surface),
        ]),
      ),
      defaults: {
        models: {
          chatgpt: defaultProbeBindings.chatgpt.model,
          gemini: defaultProbeBindings.gemini.model,
          claude: defaultProbeBindings.claude.model,
          perplexity: defaultProbeBindings.perplexity.model,
        },
        chosenOn: defaultBindingsChosenOn,
      },
      reportedModels: {
        chatgpt_app: reportedModelsOn(source.captured, 'chatgpt_app'),
      },
      labels: surfaceLabels,
      sections: completedSections.map(({ result }) => ({
        visibility: result.visibility,
      })),
    }),
  });

  const snapshotFile = path.join(dir, 'OUT', 'snapshot.json');

  if (args.quality) {
    snapshot.meta.quality = args.quality;
  }

  await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2));
  await writeFile(
    path.join(dir, 'OUT', 'labels.json'),
    JSON.stringify(enriched.labels.file, null, 2),
  );
  await writeFile(
    path.join(dir, 'OUT', 'capture-manifest.json'),
    JSON.stringify(captureManifest, null, 2),
  );
  await writeFile(
    path.join(dir, 'OUT', 'partial-failures.json'),
    JSON.stringify(partialFailures, null, 2),
  );
  await writeFile(
    path.join(dir, 'OUT', 'grounding.json'),
    JSON.stringify(grounding),
  );
  await writeFile(
    path.join(dir, 'OUT', 'label-stats.json'),
    JSON.stringify(enriched.labels.stats),
  );
  await writeFile(path.join(dir, 'OUT', 'finish.inputs.sha'), digest);

  const result: FinishResult = {
    reused: false,
    snapshot,
    labels: enriched.labels.file,
    captureManifest,
    chunks,
    grounding,
    partialFailures,
    labelStats: enriched.labels.stats,
    snapshotFile,
    written: 'skipped',
    writeMessage: null,
  };

  return args.write ? writeFinished(source, result) : result;
};

/** The local CLI writes after copy review so its stored quality metadata
 * includes both analysis and copy findings. The job commits transactionally. */
export const writeFinished = async (
  source: RunSource,
  result: FinishResult,
): Promise<FinishResult> => {
  try {
    const { request, config } = source;

    await source.stores.reportStore.writeReport(
      config.reportKey,
      request.runId,
      {
        snapshot: result.snapshot,
        grounding: result.grounding ?? undefined,
        captureManifest: result.captureManifest,
        configVersion: request.configVersion,
        labels: result.labels,
        chunks: result.chunks,
        fullScope: !request.sections && !request.surfaces,
      },
    );

    return { ...result, written: 'written', writeMessage: null };
  } catch (error) {
    return {
      ...result,
      written: 'refused',
      writeMessage:
        error instanceof StoreConflictError
          ? `the report store refused the write: ${error.message}`
          : String(error),
    };
  }
};

const isGroundingBundle = (value: unknown): value is GroundingBundle => {
  return groundingBundleSchema.safeParse(value).success;
};

/** What an earlier finish assembled from the same inputs, when its digest
 * matches and every file is still there. */
const reuseFinish = async (
  dir: string,
  digest: string,
  aggregate: AggregateOutput,
): Promise<FinishResult | null> => {
  const out = (name: string) => {
    return readFile(path.join(dir, 'OUT', name), 'utf8');
  };
  const recorded = await out('finish.inputs.sha').catch(() => null);

  if (recorded?.trim() !== digest) {
    return null;
  }

  try {
    const snapshot = aeoSnapshotSchema.parse(
      JSON.parse(await out('snapshot.json')),
    );
    const labels = domainLabelsFileSchema.parse(
      JSON.parse(await out('labels.json')),
    );
    const captureManifest = captureManifestSchema.parse(
      JSON.parse(await out('capture-manifest.json')),
    );
    const partialFailures = z
      .array(partialFailureSchema)
      .parse(JSON.parse(await out('partial-failures.json')));
    const grounding: unknown = JSON.parse(await out('grounding.json'));
    const labelStats = z
      .record(z.string(), z.number())
      .parse(JSON.parse(await out('label-stats.json')));

    // The bundle keeps its written form: later steps hash and store it.
    if (grounding !== null && !isGroundingBundle(grounding)) {
      throw new Error('OUT/grounding.json is not a grounding bundle.');
    }

    return {
      reused: true,
      snapshot,
      labels,
      captureManifest,
      chunks: Object.values(aggregate.sections).flatMap(
        (section) => section.evidenceChunks,
      ),
      grounding,
      partialFailures,
      labelStats,
      snapshotFile: path.join(dir, 'OUT', 'snapshot.json'),
      written: 'skipped',
      writeMessage: null,
    };
  } catch {
    return null;
  }
};

/** The zero-not-low guards over what this run captured (correctness spec
 * §3.1, hardening spec §2.9): a surface whose every probe had its web tool
 * rejected, an agent surface showing no web tool use across enough known
 * rows, a chat surface capturing no retrieval, an agent stream parser that
 * knows nothing. Each is a recorded partial failure, never a block: the
 * report ships and says what it could not measure. */
const webToolGuardFailures = (
  capture: CaptureArtifact,
  completedSections: Array<{ key: string; result: SectionRunResult }>,
): PartialFailure[] => {
  const sections = Object.values(capture.sections);
  const rejected = new Set(
    sections.flatMap((section) => section.rejectedWebToolSurfaces),
  );
  const failures: PartialFailure[] = [...rejected].map((surface) => ({
    step: `probes:web_tool_rejected:${surface}`,
    error:
      'every probe attempt on this surface had its web tool call rejected by the CLI; check the probe permission settings, not the client',
  }));

  const agentRows = completedSections.flatMap(({ result }) =>
    result.visibility.matrix.filter((row) => isAgentSurface(row.surface)),
  );

  failures.push(
    ...checkWebToolDetection(agentRows),
    ...checkRetrievalCapture(
      sections.flatMap((section) => section.freshChatRetrieval),
    ),
    ...checkWebToolParse(
      sections.flatMap((section) => section.freshAgentRetrieval),
    ),
  );

  return failures;
};
