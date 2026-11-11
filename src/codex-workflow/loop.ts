import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { contentHash } from '../stores/content-hash';
import { type VerifierHistory, verdictSchemaFor } from '../agents/verifier';
import {
  classifyVerifierFailure,
  type VerifierFailureOutcome,
} from '../agents/copy-validation';
import { RunOrigin, measurementDigest } from '../bundle/contracts';
import {
  openRecorder,
  recordingAccounting,
  type ExecutionRecorder,
} from '../bundle/recorder';
import { acquireWriterLock, type WriterLock } from '../bundle/writer-lock';
import { capturePlan } from '../capture-manifest';
import type { GroundingBundle } from '../grounding/schema';
import { aeoReportCopySchema, type AeoReportCopy } from '../agents/copy-schema';
import { aeoSnapshotSchema, type AeoAuditConfig } from '../schema';
import type {
  CodexStageModel,
  InternalModelRoleConfig,
} from '../models/profiles';
import type { InternalModelContext } from '../models/context';
import {
  ModelBudgetError,
  type ModelCallAccounting,
} from '../models/accounting';
import { GroundingIntegrityError } from '../grounding/validation';
import { structuredFailureDiagnostic } from '../models/failure-diagnostics';
import { isObject } from '../lib/type-guards';
import { aggregateWorkdir, type AggregateInputs } from './aggregate';
import { CopyVerificationUnavailableError } from './copy-recovery';
import { copyEditHistory, editCopyDraft, readCopyEdits } from './copy-editor';
import { validateStage } from './checks';
import {
  draftCopy,
  materializeCopyInputs,
  readCopyDocuments,
  readSnapshot,
  validateCopyDraft,
  copywriterFiles,
} from './copy';
import {
  finishRun,
  writeFinished,
  type FinishResult,
  type GroundRun,
} from './finish';
import { hostModels, pinnedProfileOf } from './host-models';
import type { StageName } from './schemas';
import type { RunSource } from './run-source';
import {
  isStageFresh,
  runStage,
  stageInputsDigest,
  defaultBatchSize,
  partition,
  type StageContext,
  type StageRun,
} from './stage';
import { materializeWorkdir } from './workdir';
import { stableBatchLayout } from './batch-layout';
import {
  maxReviewRounds,
  readStoredReview,
  reportQuality,
  type ReportQuality,
} from './quality';
import { writePendingJson } from './pending';
import { writeRunInputs } from './run-inputs';

// ============================================================================
// The loop (specs/aeo-codex-workflow-spec.md §5), shared by the local CLI
// and the container job: analyze, qualify, the host's aggregate, scrutiny
// passes until one is accepted, finish, then the copy. A judgment problem
// degrades the run and is recorded on the delivered snapshot. Everything is reused by
// digest, so calling it again on the same directory is the resume.
// ============================================================================

export const defaultMaxPasses = maxReviewRounds;

export type WorkflowContext = StageContext & {
  aggregate: AggregateInputs;
  source: RunSource;
  /** Credential values a draft must never contain; the caller's, never
   * read from the environment here. */
  secrets: readonly string[];
  /** The job's pinned accounting, when supplied. Local host steps start
   * their own memory budgets when they run, after the Codex stages. */
  internalModels?: InternalModelContext;
  signal?: AbortSignal;
  log: (line: string) => void;
  /** Gives the run directory back; the caller's, once its work is done. */
  releaseWriter: () => Promise<void>;
};

/** The host's model context for one step: the job's pinned accounting,
 * or a fresh memory budget, recorded either way when the run records (the
 * pinned one is wrapped once, by prepareWorkdir). */
const hostModelsOf = (
  ctx: Pick<WorkflowContext, 'internalModels' | 'recorder'> &
    Partial<Pick<WorkflowContext, 'source'>>,
): InternalModelContext => {
  if (ctx.internalModels) {
    return ctx.internalModels;
  }

  const models = hostModels(pinnedProfileOf(ctx.source?.request.modelProfile));

  return ctx.recorder
    ? {
        ...models,
        accounting: recordingAccounting(models.accounting, ctx.recorder),
      }
    : models;
};

/** What the copy stage writes from and is held to. A run's own inputs come
 * from its source (`copyInputsOf`); a rewrite pass over a committed run
 * supplies them from the store, with the draft the reviewer saw. */
export type CopyInputs = {
  config: AeoAuditConfig;
  runId: string;
  configVersion: number | undefined;
  grounding: GroundingBundle | null;
  verifierRole?: InternalModelRoleConfig;
  brandLogo?: AeoReportCopy['brandLogo'];
  previous?: AeoReportCopy | null;
  notes?: readonly string[];
};

export const copyInputsOf = (
  source: RunSource,
  extra: Pick<CopyInputs, 'brandLogo' | 'previous' | 'notes'> = {},
): CopyInputs => {
  return {
    config: source.config,
    runId: source.request.runId,
    configVersion: source.request.configVersion,
    grounding: source.grounding,
    verifierRole: source.request.modelProfile?.roles.premiseVerifier,
    ...extra,
  };
};

/** What the copy stage keeps when the host accepts a draft. A key whose
 * value was undefined is absent from the written file. */
const copyPayloadSchema = z.looseObject({
  copy: aeoReportCopySchema,
  provenance: z.unknown().optional(),
  receipt: z.unknown().optional(),
  confidence: z.number(),
  outcome: z.string(),
  draft: z.unknown().optional(),
  quality: aeoSnapshotSchema.shape.meta.shape.quality,
});

export type CopyPayload = z.infer<typeof copyPayloadSchema>;

export type WorkflowResult = {
  verdict: 'accepted' | 'needs_another_pass';
  degraded: string[];
  finish: FinishResult | null;
  /** The validated copy, when the copy stage produced one. */
  copy: CopyPayload | null;
  /** Validated copy includes the deterministic fact compilation used when
   * narrative review needs further work. Errors describe host failures. */
  copyOutcome: 'validated' | 'refused' | 'errored' | 'skipped';
  scorecard: Record<string, unknown>;
};

/** The work directory from a source: answers, config, rules, schemas. */
export const prepareWorkdir = async (
  source: RunSource,
  dir: string,
  options: {
    secrets?: readonly string[];
    internalModels?: InternalModelContext;
    signal?: AbortSignal;
    log?: (line: string) => void;
    /** Who runs the workflow: the CLI on an operator's machine, or the
     * hosted job. Recorded in the run journal; never inferred. */
    origin?: RunOrigin;
    /** A caller that already holds the directory and its journal, because
     * it recorded the capture before the workflow (a local run). Its
     * internalModels must already charge through that journal. */
    held?: { writer: WriterLock; recorder: ExecutionRecorder };
    /** The Codex stages' model for a run whose pinned profile carries none
     * (one pinned before profiles did). A profile's own always wins. */
    stageModel?: CodexStageModel;
    /** The run's ledger, unwrapped: every Codex session is reserved and
     * settled on it beside the host's model calls (specs/aeo-claude-
     * operator-spec.md §4.2). A session is a codex_session operation of
     * its own, so it never goes through the recording wrapper. */
    ledger?: ModelCallAccounting;
  } = {},
): Promise<WorkflowContext> => {
  if (options.held) {
    return prepareLockedWorkdir(source, dir, {
      ...options,
      writer: options.held.writer,
    });
  }

  await mkdir(dir, { recursive: true });

  const writer = await acquireWriterLock(dir, 'codex workflow');

  try {
    return await prepareLockedWorkdir(source, dir, {
      ...options,
      writer,
    });
  } catch (err) {
    await writer.release();

    throw err;
  }
};

const prepareLockedWorkdir = async (
  source: RunSource,
  dir: string,
  options: Parameters<typeof prepareWorkdir>[2] & { writer: WriterLock },
): Promise<WorkflowContext> => {
  const { writer } = options;
  const answers = await materializeWorkdir({
    dir,
    config: source.config,
    captured: source.captured,
    copyRules: (await copywriterFiles())['RULES.md'] ?? '',
  });

  await writeRunInputs(dir, source);

  const recorder =
    options.held?.recorder ??
    (await openRecorder(dir, {
      origin: options.origin ?? RunOrigin.LOCAL,
      runId: source.request.runId,
      measurementDigest: measurementDigest({
        config: source.config,
        surfaces: source.surfaces,
        sections: source.request.sections ?? null,
      }),
      planDigest: capturePlan(
        source.config,
        source.surfaces,
        source.request.sections,
      ).digest,
      ...(writer.takenOver && { takenOver: writer.takenOver }),
    }));
  const internalModels = options.held
    ? options.internalModels
    : options.internalModels && {
        ...options.internalModels,
        accounting: recordingAccounting(
          options.internalModels.accounting,
          recorder,
        ),
      };

  const stageModel = source.request.modelProfile?.stages ?? options.stageModel;

  if (!stageModel) {
    throw new Error(
      'The run pins no Codex stage model: its profile has no `stages` and the caller supplied none.',
    );
  }

  const log =
    options.log ??
    ((line: string) => {
      // eslint-disable-next-line no-console -- Without a caller's sink, the run's progress lines are the CLI's terminal output.
      console.log(line);
    });

  log(
    `${source.reportKey} ${source.id}: ${answers.length} captured answers in ${dir}`,
  );

  return {
    dir,
    brand: source.config.brand,
    answers,
    allAnswers: answers,
    batchLayout: await stableBatchLayout(dir, {
      config: source.config,
      files: partition(answers).flatMap((batch) =>
        batch.files.map((answer) => answer.file),
      ),
      size: defaultBatchSize,
    }),
    sections: source.config.sections.map((section) => section.key),
    ownedDomains: source.config.competitorQualification?.ownedDomains,
    source,
    secrets: options.secrets ?? [],
    internalModels,
    stageModel,
    ...(options.ledger && { accounting: options.ledger }),
    recorder,
    releaseWriter: writer.release,
    signal: options.signal,
    log,
    aggregate: {
      dir,
      config: source.config,
      surfaces: source.surfaces,
      capture: source.capture,
      captured: source.captured,
    },
  };
};

// The verifier's own history, written by this module; the review entries
// are kept as the verifier wrote them.
const savedVerifierMemorySchema = z
  .object({
    scope: z.string(),
    history: z.record(
      z.string(),
      z.array(
        z.object({
          text: z.string(),
          review: verdictSchemaFor([], []).shape.reviews.element,
        }),
      ),
    ),
  })
  .nullable();

/** The copy stage's inputs from the finished snapshot, and the host's
 * verdict on what the writer produces. */
export const withCopy = async <
  T extends StageContext &
    Pick<WorkflowContext, 'secrets' | 'internalModels'> &
    Partial<Pick<WorkflowContext, 'log'>>,
>(
  ctx: T,
  inputs: CopyInputs,
): Promise<T> => {
  const snapshot = await readSnapshot(ctx.dir);

  const copyFiles = await materializeCopyInputs({
    dir: ctx.dir,
    config: inputs.config,
    snapshot,
    runId: inputs.runId,
    grounding: inputs.grounding,
    previous: inputs.previous,
    notes: inputs.notes,
  });

  const internalModels = hostModelsOf(ctx);
  const memoryFile = path.join(ctx.dir, 'PENDING', 'verifier-history.json');
  const memoryScope = contentHash({
    config: inputs.config,
    runId: inputs.runId,
    snapshot,
    grounding: inputs.grounding,
    role: inputs.verifierRole,
  });

  const verifierMemory = {
    read: async () => {
      const raw = await readFile(memoryFile, 'utf8').catch(() => 'null');
      const saved = savedVerifierMemorySchema.parse(JSON.parse(raw));

      return saved?.scope === memoryScope ? saved.history : {};
    },
    write: async (history: VerifierHistory) => {
      await writePendingJson(memoryFile, { scope: memoryScope, history });
      await ctx.checkpoint?.(['PENDING/verifier-history.json']);
    },
    edits: async () =>
      copyEditHistory(await readCopyEdits(ctx.dir, memoryScope)),
  };

  const validation = {
    config: inputs.config,
    snapshot,
    runId: inputs.runId,
    configVersion: inputs.configVersion,
    grounding: inputs.grounding,
    secrets: ctx.secrets,
    verifierRole:
      inputs.verifierRole ?? internalModels.profile.roles.premiseVerifier,
    previous: inputs.previous,
    brandLogo: inputs.brandLogo,
    accounting: internalModels.accounting,
    signal: ctx.signal,
  };

  const review = async (draft: unknown) => {
    const shape = validateStage(
      { brand: ctx.brand, answers: [], sections: ctx.sections, coverage: true },
      'write',
      draft,
    );

    return shape.errors.length
      ? {
          valid: false as const,
          outcome: 'invalid_copy' as const,
          errors: shape.errors.map((message) => ({
            path: 'draft',
            code: 'schema_invalid',
            message,
          })),
        }
      : validateCopyDraft({ ...validation, draft, verifierMemory });
  };

  return {
    ...ctx,
    // One request carries what the writer is given, as it stands on disk.
    draftCopy: async () => {
      const { draft, usage } = await draftCopy({
        role: internalModels.profile.roles.copy,
        documents: await readCopyDocuments(ctx.dir, copyFiles),
        sections: inputs.config.sections.map((section) => section.key),
        accounting: internalModels.accounting,
        signal: ctx.signal,
      });

      return {
        draft,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        },
      };
    },
    validateCopy: async (
      initialDraft,
      { round = 1, previousFindings, reviewed } = {},
    ) => {
      // Findings already in hand (a previous round's recheck, or the initial
      // review a retry resumes after) are complete: the draft is not
      // reviewed again, and the edit is made from exactly them.
      const requestedNotes =
        round === 1
          ? (inputs.notes ?? []).map((note) => `Requested edit: ${note}`)
          : [];

      let draft = initialDraft;
      let result =
        previousFindings?.length || requestedNotes.length
          ? null
          : await review(draft);

      const findings = previousFindings?.length
        ? [...previousFindings]
        : [
            ...(result?.errors ?? []).map(
              (error) => `${error.path}: ${error.message} (${error.code})`,
            ),
            ...requestedNotes,
          ];

      let editedDraft: unknown;

      if (!result || result.outcome === 'invalid_copy') {
        if (result) {
          await reviewed?.(findings);
        }

        try {
          editedDraft = await editCopyDraft({
            dir: ctx.dir,
            scope: memoryScope,
            round,
            draft,
            errors: findings,
            validation,
            reviewHistory: await verifierMemory.read(),
            checkpoint: ctx.checkpoint,
          });
          // This includes the fifth edit: a repaired final draft is never
          // discarded merely because its recheck would fall beyond the loop.
          result = await review(editedDraft);
          draft = editedDraft;
        } catch (error) {
          const outcome = classifyVerifierFailure(error, ctx.signal);

          ctx.log?.(
            `copy verifier edit/recheck unavailable: ${outcome}; ${JSON.stringify(structuredFailureDiagnostic(error, ctx.signal))}`,
          );

          return {
            ok: false,
            fixable: false,
            outcome,
            errors: [
              'The verifier could not complete its edit and recheck; its saved work is retained',
            ],
          };
        }
      }

      if (result.valid) {
        return {
          ok: true,
          fixable: false,
          errors: [],
          editedDraft,
          payload: {
            copy: result.copy,
            provenance: result.provenance,
            receipt: result.receipt,
            confidence: isObject(draft) ? draft.confidence : undefined,
            outcome: result.outcome,
          },
        };
      }

      return {
        ok: false,
        outcome: result.outcome,
        fixable: result.outcome === 'invalid_copy',
        editedDraft,
        errors: result.errors.map(
          (error) => `${error.path}: ${error.message} (${error.code})`,
        ),
      };
    },
  };
};

export type FinishOptions = {
  degraded: readonly string[];
  write: boolean;
  ground?: GroundRun;
  quality?: ReportQuality;
};

/** The report snapshot from the accepted outputs, into the work directory
 * and, when asked and permitted, the report store. */
export const finish = async (
  ctx: WorkflowContext,
  { degraded, write, ground, quality }: FinishOptions,
): Promise<FinishResult> => {
  const result = await finishRun({
    source: ctx.source,
    dir: ctx.dir,
    degraded,
    write,
    ground,
    stageModelId: ctx.stageModel.model,
    internalModels: hostModelsOf(ctx),
    signal: ctx.signal,
    quality,
  });

  // The bundle the copy stage and the commit read is the one the snapshot
  // was assembled with; the run source is the state they share.
  // eslint-disable-next-line no-param-reassign -- The shared run source carries the grounding to the copy stage and the commit.
  ctx.source.grounding = result.grounding;
  await ctx.checkpoint?.();

  const labels = Object.entries(result.labelStats)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');

  ctx.log(
    `finish: snapshot ${path.relative(process.cwd(), result.snapshotFile)}, ${result.partialFailures.length} partial failure(s), labels ${labels}; store ${result.written}${result.writeMessage ? ` (${result.writeMessage})` : ''}`,
  );

  return result;
};

/** The host's arithmetic over the corrected outputs; rerun whenever a row
 * changed, so METRICS.json is always the numbers the current rows give. */
export const aggregate = async (ctx: WorkflowContext) => {
  const output = await aggregateWorkdir(ctx.aggregate);

  for (const [key, result] of Object.entries(output.sections)) {
    const { summary, matrix } = result.visibility;

    ctx.log(
      `aggregate ${key}: ${matrix.length} rows, sov ${summary.prospectShareOfVoice ?? 'n/a'} chat / ${summary.agentShareOfVoice ?? 'n/a'} agent${summary.consumerShareOfVoice === undefined ? '' : ` / ${summary.consumerShareOfVoice ?? 'n/a'} consumer`}, top competitor ${summary.topCompetitorDomain ?? 'none'}`,
    );
  }
};

const runVerdict = (run: StageRun, reused: boolean) => {
  if (reused) {
    return 'reused';
  }

  return run.ok ? 'ok' : 'FAILED';
};

const report = (
  ctx: Pick<WorkflowContext, 'log'>,
  run: StageRun,
  { reused = false }: { reused?: boolean } = {},
) => {
  const verdict = runVerdict(run, reused);
  const usage = run.usage
    ? ` ${run.usage.inputTokens} in / ${run.usage.outputTokens} out`
    : '';

  ctx.log(
    `${verdict.padEnd(7)} ${run.stage} (${Math.round(run.durationMs / 1000)}s${usage}) ${JSON.stringify(run.summary)}`,
  );

  for (const error of run.errors) {
    ctx.log(`       ${error.slice(0, 300)}`);
  }
};

const workflowStateSchema = z.looseObject({
  stages: z.array(z.record(z.string(), z.unknown())).optional(),
});

const writeState = async (dir: string, run: StageRun) => {
  const file = path.join(dir, 'STATE.json');
  const raw = (await readFile(file, 'utf8').catch(() => '{}')) || '{}';
  const state = workflowStateSchema.parse(JSON.parse(raw));

  state.stages = [
    ...(state.stages ?? []),
    { ...run, at: new Date().toISOString() },
  ];
  await writeFile(file, JSON.stringify(state, null, 2));
};

// A recorded stage result, as far as a reused run carries it forward.
const recordedRunSchema = z
  .looseObject({
    degraded: z.array(z.string()).optional(),
    summary: z.record(z.string(), z.unknown()).optional(),
  })
  .nullable();

export const runOne = async (
  ctx: StageContext & Pick<WorkflowContext, 'log'>,
  stage: StageName,
  { force, pass }: { force: boolean; pass?: number },
): Promise<StageRun> => {
  if (!force && (await isStageFresh(ctx, stage))) {
    const raw = await readFile(
      path.join(ctx.dir, 'OUT', `${stage}.result.json`),
      'utf8',
    ).catch(() => 'null');

    const previous = recordedRunSchema.parse(JSON.parse(raw));
    const run: StageRun = {
      stage,
      model: ctx.stageModel.model,
      ok: true,
      durationMs: 0,
      usage: null,
      errors: [],
      degraded: previous?.degraded ?? [],
      summary: { ...previous?.summary, reused: true },
    };

    report(ctx, run, { reused: true });

    return run;
  }

  const run = await runStage(ctx, stage, { pass, force });

  report(ctx, run);
  await writeState(ctx.dir, run);

  return run;
};

/** The generated narrative is an enrichment. If its review limit is
 * exhausted, compile only frozen facts through the same receipt checker
 * and deliver the complete measurement with an explicit improvement note. */
export const deliverableCopy = async (
  ctx:
    | WorkflowContext
    | (StageContext &
        Pick<WorkflowContext, 'secrets' | 'internalModels' | 'log'>),
  inputs: CopyInputs,
  written: StageRun,
): Promise<CopyPayload> => {
  if (written.ok) {
    const raw = await readFile(path.join(ctx.dir, 'OUT', 'write.json'), 'utf8');

    return copyPayloadSchema.parse(JSON.parse(raw));
  }

  const draft = {
    intro: [{ kind: 'fact', factId: 'aggregate:captured' }],
    sections: Object.fromEntries(
      inputs.config.sections.map((section) => [section.key, { subtitle: [] }]),
    ),
    confidence: 1,
  };

  const validated = await validateCopyDraft({
    ...inputs,
    draft,
    snapshot: await readSnapshot(ctx.dir),
    secrets: ctx.secrets,
    verifierRole:
      inputs.verifierRole ?? hostModelsOf(ctx).profile.roles.premiseVerifier,
    accounting: ctx.internalModels?.accounting,
  });

  if (
    !validated.valid ||
    !validated.copy ||
    !validated.provenance ||
    !validated.receipt
  ) {
    throw new Error(
      `Frozen report facts did not validate: ${validated.errors.map((error) => error.code).join(', ')}.`,
    );
  }

  const quality: ReportQuality = {
    needsImprovement: true,
    reviewRounds: Math.min(
      Number(written.summary.attempts ?? defaultMaxPasses),
      defaultMaxPasses,
    ),
    issues: [
      {
        stage: 'write',
        code: 'narrative_needs_improvement',
        message:
          'The report uses verified measurement facts while its narrative needs improvement.',
      },
      ...written.errors.map((message) => ({
        stage: 'write',
        code: 'copy_review',
        message,
      })),
    ],
  };

  const payload: CopyPayload = {
    copy: validated.copy,
    provenance: validated.provenance,
    receipt: validated.receipt,
    outcome: validated.outcome,
    confidence: 1,
    draft,
    quality,
  };

  await writeFile(
    path.join(ctx.dir, 'OUT', 'write.json'),
    JSON.stringify(payload, null, 2),
  );
  await writeFile(
    path.join(ctx.dir, 'OUT', 'write.inputs.sha'),
    await stageInputsDigest(ctx, 'write'),
  );
  await ctx.checkpoint?.();
  ctx.log(
    'copy: delivering verified report facts; narrative improvement notes retained',
  );

  return payload;
};

/** Verifier outcomes the copy ships without (the pipeline is additive: a
 * verifier that keeps answering unusably after its tries costs the report
 * its narrative, never its delivery). Budget, deadline, integrity and
 * cancellation are the host's blockers and stay thrown. */
const shipWithoutVerifier = new Set<VerifierFailureOutcome>([
  'invalid_review',
  'verifier_unavailable',
]);

export const writeReportCopy = async (
  ctx: StageContext &
    Pick<WorkflowContext, 'secrets' | 'internalModels' | 'log'>,
  inputs: CopyInputs,
  { force }: { force: boolean },
): Promise<{ run: StageRun; copy: CopyPayload }> => {
  // Only actual draft refusals exhaust editorial rounds. Worker failures
  // preserve the checkpoint for recovery and cannot manufacture a review.
  let run: StageRun;

  try {
    run = await runOne(ctx, 'write', { force });
  } catch (error) {
    if (
      !(error instanceof CopyVerificationUnavailableError) ||
      !shipWithoutVerifier.has(error.outcome) ||
      ctx.signal?.aborted
    ) {
      throw error;
    }

    // The verifier stayed unusable through its tries (one run's six
    // invalid reviews failed the pipeline). The report ships on its
    // verified facts with the improvement note; the saved draft is kept.
    ctx.log(
      `copy verifier stayed ${error.outcome} after its tries; delivering the verified facts without the narrative`,
    );
    run = {
      stage: 'write',
      model: ctx.stageModel.model,
      ok: false,
      durationMs: 0,
      usage: null,
      errors: error.errors.map(
        (message) => `verifier ${error.outcome}: ${message}`,
      ),
      degraded: [],
      summary: { attempts: defaultMaxPasses, verifier: error.outcome },
    };
  }

  return { run, copy: await deliverableCopy(ctx, inputs, run) };
};

/** The answers a later stage still judges once a batch degraded;
 * `allAnswers` stays the run's full set. */
const withoutAnswers = (
  ctx: WorkflowContext,
  files: readonly string[],
): WorkflowContext => {
  const gone = new Set(files);

  return {
    ...ctx,
    answers: ctx.answers.filter((answer) => !gone.has(answer.file)),
  };
};

const correctionTrailSchema = z.array(
  z.looseObject({ outcome: z.string().optional() }),
);

type ScorecardFinish = { partialFailures: number; store: string };

/** What one run of the pipeline was worth (Andrei, 2026-09-13: measure
 * the pipeline and iterate). Written to SCORECARD.json at the end, one
 * shape every run, so runs compare. */
class Scorecard {
  readonly #ctx: WorkflowContext;
  readonly #startedAt: string;
  readonly #runs: StageRun[];
  readonly #stages: Record<string, unknown>[];
  #finish: ScorecardFinish | null;
  #copyOutcome: WorkflowResult['copyOutcome'];

  constructor(ctx: WorkflowContext) {
    this.#ctx = ctx;
    this.#startedAt = new Date().toISOString();
    this.#runs = [];
    this.#stages = [];
    this.#finish = null;
    this.#copyOutcome = 'skipped';
  }

  finished(partialFailures: number, store: string) {
    this.#finish = { partialFailures, store };
  }

  copy(outcome: WorkflowResult['copyOutcome']) {
    this.#copyOutcome = outcome;
  }

  stage(run: StageRun, pass?: number) {
    this.#runs.push(run);
    this.#stages.push({
      stage: run.stage,
      ...(pass ? { pass } : {}),
      ok: run.ok,
      durationMs: run.durationMs,
      usage: run.usage,
      ...run.summary,
      ...(run.degraded.length ? { degradedFiles: run.degraded } : {}),
      ...(run.errors.length
        ? { errors: run.errors.map((error) => error.slice(0, 300)) }
        : {}),
    });
  }

  async write(
    verdict: WorkflowResult['verdict'],
  ): Promise<Record<string, unknown>> {
    const { dir } = this.#ctx;
    const review = await readStoredReview(dir);
    const trailText =
      (await readFile(path.join(dir, 'OUT', 'corrections.json'), 'utf8').catch(
        () => '[]',
      )) || '[]';

    const trail = correctionTrailSchema.parse(JSON.parse(trailText));
    const runs = this.#runs;

    const total = (key: 'inputTokens' | 'outputTokens') => {
      return runs.reduce((sum, run) => sum + (run.usage?.[key] ?? 0), 0);
    };

    const card = {
      version: 1,
      startedAt: this.#startedAt,
      finishedAt: new Date().toISOString(),
      model: this.#ctx.stageModel.model,
      answers: this.#ctx.answers.length,
      verdict,
      stages: this.#stages,
      corrections: {
        applied: trail.filter((entry) => entry.outcome === 'applied').length,
        refused: trail.filter((entry) => entry.outcome?.startsWith('refused'))
          .length,
      },
      reviewPasses: runs.filter((run) => run.stage === 'review').length,
      failedCriteria: (review?.criteria ?? [])
        .filter((criterion) => criterion.outcome === 'fail')
        .map((criterion) => criterion.criterionId),
      unresolved: review?.unresolved.length ?? 0,
      finish: this.#finish,
      copy: this.#copyOutcome,
      degraded: runs.flatMap((run) => run.degraded),
      durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
      usage: {
        inputTokens: total('inputTokens'),
        outputTokens: total('outputTokens'),
      },
    };

    await writeFile(
      path.join(dir, 'SCORECARD.json'),
      JSON.stringify(card, null, 2),
    );
    this.#ctx.log(
      `scorecard: ${verdict}, ${card.reviewPasses} pass(es), ${card.corrections.applied} corrections (${card.corrections.refused} refused), ${card.unresolved} unresolved, ${card.degraded.length} degraded, ${Math.round(card.durationMs / 60000)} min, ${Math.round(card.usage.inputTokens / 1000)}k in / ${Math.round(card.usage.outputTokens / 1000)}k out`,
    );

    return card;
  }
}

const reviewProgressSchema = z
  .object({ rounds: z.number(), digest: z.string(), accepted: z.boolean() })
  .nullable();

/** The whole loop over one work directory. Never throws for a judgment
 * problem; the source is left open for the caller to close. */
type RunWorkflowOptions = {
  maxPasses?: number;
  force?: boolean;
  write?: boolean;
  /** Factual grounding over the run's capture manifest (the container
   * job); a source that already carries a bundle needs none. */
  ground?: GroundRun;
  /** The report's logo for the validated copy, resolved once the copy
   * stage is due (the job's; a local run has none). */
  brandLogo?: () => Promise<AeoReportCopy['brandLogo'] | undefined>;
};

/**
 * runWorkflow runs the loop over a prepared work directory. A run that
 * throws records why in the run journal before the error travels on:
 * run_interrupted when the host stopped the work, run_failed otherwise.
 */
export const runWorkflow = async (
  prepared: WorkflowContext,
  options: RunWorkflowOptions = {},
): Promise<WorkflowResult> => {
  try {
    return await runWorkflowSteps(prepared, options);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    try {
      await prepared.recorder?.record(
        prepared.signal?.aborted ? 'run_interrupted' : 'run_failed',
        {
          error: err instanceof Error ? err.name : typeof err,
          // Bounded: the message names what broke, not a dump of state.
          reason: reason.slice(0, 500),
        },
      );
    } catch (recordError) {
      // The run's own failure is what the caller must see; a journal that
      // cannot take the entry ends open, which reads as interrupted.
      prepared.log(
        `run journal: the failure could not be recorded: ${String(recordError).slice(0, 200)}`,
      );
    }

    throw err;
  }
};

const runWorkflowSteps = async (
  prepared: WorkflowContext,
  options: RunWorkflowOptions,
): Promise<WorkflowResult> => {
  const force = options.force ?? false;
  const maxPasses = Math.max(
    1,
    Math.min(options.maxPasses ?? defaultMaxPasses, defaultMaxPasses),
  );

  const scorecard = new Scorecard(prepared);
  let ctx = prepared;

  for (const stage of ['analyze', 'qualify'] as const) {
    // Nothing judgment-related stops a run: a stage that accepted nothing
    // delivers its empty output with every answer degraded.
    const run = await runOne(ctx, stage, { force });

    scorecard.stage(run);

    if (run.degraded.length) {
      ctx = withoutAnswers(ctx, run.degraded);
    }
  }

  await aggregate(ctx);
  await ctx.checkpoint?.();

  const progressFile = path.join(ctx.dir, 'REVIEW', 'progress.json');
  const savedProgress = reviewProgressSchema.parse(
    JSON.parse(await readFile(progressFile, 'utf8').catch(() => 'null')),
  );
  // Progress counts only while it describes the current reviewed state.
  const progress =
    !force && savedProgress?.digest === (await stageInputsDigest(ctx, 'review'))
      ? savedProgress
      : null;

  let rounds = progress?.rounds ?? 0;
  let verdict: WorkflowResult['verdict'] = progress?.accepted
    ? 'accepted'
    : 'needs_another_pass';

  for (
    let pass = rounds + 1;
    verdict !== 'accepted' && pass <= maxPasses;
    pass += 1
  ) {
    // The same reviewer continues over its corrected state. Accepted
    // batches stay accepted; no earlier stage is re-entered.
    const run = await runOne(ctx, 'review', { force: pass > 1 || force, pass });

    scorecard.stage(run, pass);
    rounds = pass;

    if (!run.ok) {
      ctx.log(
        `review pass ${pass} produced nothing the host could accept; the state stands as it is`,
      );
    }

    if (Number(run.summary.corrections ?? 0) > 0) {
      await aggregate(ctx);
    }

    // A reused pass carries its recorded verdict; only an acceptance with
    // nothing corrected ends the scrutiny.
    if (
      run.ok &&
      !Number(run.summary.corrections ?? 0) &&
      !Number(run.summary.refusedCorrections ?? 0) &&
      run.summary.verdict === 'accepted'
    ) {
      verdict = 'accepted';
      ctx.log(`accepted after ${pass} scrutiny pass${pass === 1 ? '' : 'es'}`);
    }

    await mkdir(path.dirname(progressFile), { recursive: true });
    await writeFile(
      progressFile,
      JSON.stringify({
        rounds,
        digest: await stageInputsDigest(ctx, 'review'),
        accepted: verdict === 'accepted',
      }),
    );
    await ctx.checkpoint?.();
  }

  if (verdict !== 'accepted') {
    ctx.log(
      `not accepted after ${maxPasses} scrutiny passes; the report ships with the open notes in REVIEW/`,
    );
  }

  const degraded = prepared.answers
    .map((answer) => answer.file)
    .filter((file) => !ctx.answers.some((answer) => answer.file === file));
  let finished: FinishResult | null = null;

  try {
    finished = await finish(ctx, {
      degraded,
      write: false,
      ground: options.ground,
      quality: await reportQuality(ctx.dir, {
        rounds,
        degraded,
        accepted: verdict === 'accepted',
      }),
    });
    scorecard.finished(finished.partialFailures.length, finished.written);
  } catch (error) {
    if (isBlocker(error, ctx.signal)) {
      throw error;
    }

    ctx.log(`finish failed: ${String(error).slice(0, 400)}`);
    scorecard.finished(-1, 'failed');
  }

  // Copy enriches the completed measurement. Bounded review delivers either
  // the verified narrative or compiled facts with improvement notes.
  let copy: CopyPayload | null = null;
  let copyOutcome: WorkflowResult['copyOutcome'] = 'skipped';

  if (finished) {
    try {
      const inputs = copyInputsOf(ctx.source, {
        brandLogo: await options.brandLogo?.(),
      });
      const copyContext = await withCopy(ctx, inputs);
      const { run: written, copy: delivered } = await writeReportCopy(
        copyContext,
        inputs,
        { force },
      );

      scorecard.stage(written);
      copy = delivered;
      copyOutcome = 'validated';

      if (copy.quality) {
        const quality = finished.snapshot.meta.quality;

        if (!quality) {
          throw new Error(
            `The finished snapshot has no quality record: ${finished.snapshotFile}.`,
          );
        }

        quality.needsImprovement = true;
        quality.issues.push(...copy.quality.issues);
        await writeFile(
          finished.snapshotFile,
          JSON.stringify(finished.snapshot, null, 2),
        );
        await ctx.checkpoint?.();
      }
    } catch (error) {
      if (isBlocker(error, ctx.signal)) {
        throw error;
      }

      ctx.log(`copy stage failed: ${String(error).slice(0, 400)}`);
      copyOutcome = 'errored';
    }
  }

  scorecard.copy(copyOutcome);

  if (finished && options.write) {
    finished = await writeFinished(ctx.source, finished);
    scorecard.finished(finished.partialFailures.length, finished.written);
    ctx.log(
      `store: ${finished.written}${finished.writeMessage ? ` (${finished.writeMessage})` : ''}`,
    );
  }

  const finalScorecard = await scorecard.write(verdict);

  await ctx.recorder?.record('run_completed', {
    verdict,
    copyOutcome,
    finished: finished !== null,
    degradedAnswers: degraded.length,
  });
  await ctx.checkpoint?.();

  return {
    verdict,
    degraded,
    finish: finished,
    copy,
    copyOutcome,
    scorecard: finalScorecard,
  };
};

/** What the loop must not absorb as a host defect: a budget or deadline
 * the job blocks on resumably, a grounding integrity failure, or the host
 * stopping the work. Everything else degrades the run and is recorded. */
const isBlocker = (
  error: unknown,
  signal: AbortSignal | undefined,
): boolean => {
  return (
    error instanceof ModelBudgetError ||
    error instanceof GroundingIntegrityError ||
    signal?.aborted === true
  );
};
