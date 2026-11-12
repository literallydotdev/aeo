import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { CopyValidationOutcome } from '../agents/copy-validation';
import type { AeoBrand } from '../schema';
import { killChildProcessGroup } from '../probes/child-process';
import { isAuthError } from '../probes/failure';
import { isObject } from '../lib/type-guards';
import { getEnvironment, readEnv } from '../lib/env';
import type { ExecutionRecorder } from '../bundle/recorder';
import {
  ModelBudgetError,
  type ModelCallAccounting,
} from '../models/accounting';
import {
  sessionReservation,
  type SessionCost,
} from '../models/cost-coefficients';
import { tokenCostUsd } from '../models/pricing';
import type { CodexStageModel } from '../models/profiles';
import {
  mergeBatches,
  restoreQualificationQuotes,
  validateStage,
  type CheckScope,
  type StageValue,
} from './checks';
import { codexArgs, codexBinaryAt, resolveCodexBinary } from './codex-binary';
import {
  codexGateway,
  codexStageConfig,
  prepareCodexHome,
  type ResearchServerConfig,
} from './codex-home';
import { copyDir } from './copy';
import { authorFiles, authorPacket, authorSessionInputs } from './author';
import {
  stagePrompts,
  sessionPrompt,
  type SessionPromptOptions,
} from './prompts';
import {
  stageVersions,
  isStageName,
  qualifyRowSchema,
  type Correction,
  type QualifyOutput,
  type StageName,
  stageJsonSchema,
} from './schemas';
import type { AnswerFile } from './workdir';
import { forgetSession, readSession, saveSession } from './session';
import { reserveWhenAffordable } from './session-gate';
import { maxReviewRounds } from './quality';
import type { BatchLayout } from './batch-layout';
import {
  CopyVerificationUnavailableError,
  recoverEditorialRounds,
} from './copy-recovery';
import { writePendingJson } from './pending';
import { batchInput } from './batch-input';

// ============================================================================
// One Codex stage (specs/aeo-codex-workflow-spec.md §4) over a work
// directory, in batches: a small model reads ten answers well and a hundred
// and twenty not at all, so a stage is partitioned by answer file, each
// batch is one `codex exec` with its own output, digest, notes and events,
// batches run a few at a time, and the host merges them into the stage's
// OUT file and validates the whole. What differs between stages is one
// descriptor each (stageSpecs); the runner reads the descriptor and never asks
// which stage it is running. Two protocols settle a batch: a Codex batch
// (runCodexBatch) is refused and fed back until it validates; the copy
// (runVerifiedCopy) is handed to the host's verifier, which owns every
// edit. The checks themselves live in checks.ts and the prompts in
// prompts.ts.
// ============================================================================

/** Tokens a Codex session reported: cached input is part of input. */
export type SessionUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type StageRun = {
  stage: StageName;
  model: string;
  /** The merged output exists; batches that never validated are listed in
   * `degraded` and their answers carry no judgment from this stage. */
  ok: boolean;
  durationMs: number;
  usage: SessionUsage | null;
  errors: string[];
  /** Answer files whose batch never validated: excluded from this stage
   * and every later one, recorded, never a reason to stop the run. */
  degraded: string[];
  /** A reason no further session could fix, such as a credential the
   * model provider rejected (`auth`): the batch stopped early and the host
   * decides what the run does with it. */
  fatal?: string;
  summary: Record<string, unknown>;
};

export type StageContext = {
  dir: string;
  brand: AeoBrand;
  answers: readonly AnswerFile[];
  /** Every answer of the run, never narrowed: once a batch degrades,
   * `answers` is what later stages still judge, while corrections and the
   * evidence they cite are checked against the whole run. */
  allAnswers?: readonly AnswerFile[];
  /** The configured section keys; the copy draft must name every one. */
  sections?: readonly string[];
  /** Hosts the client owns besides its brand domain; never competitors. */
  ownedDomains?: readonly string[];
  /** The host stopping the work: sessions are killed and no batch starts. */
  signal?: AbortSignal;
  /** The model every session runs on (the run's pinned stage model). */
  stageModel: CodexStageModel;
  /** The run's ledger: every session is reserved before it starts and
   * settled from its reported tokens. Absent, sessions are not charged. */
  accounting?: ModelCallAccounting;
  /** Overrides for tests: the command to run instead of the engine's own
   * Codex. */
  command?: string;
  timeoutMs?: number;
  /** Answers per Codex session; the default fits the pinned model. */
  batchSize?: number;
  batchLayout?: BatchLayout;
  /** Batches in flight at once. */
  concurrency?: number;
  /** The host's asynchronous verdict on a copy draft (facts, banlist,
   * premises, the premise verifier): the initial review when no findings
   * are supplied, then the verifier's edit from the findings and its
   * recheck. `reviewed` receives the initial review's findings before the
   * paid edit, for the host to persist. */
  validateCopy?: (
    draft: unknown,
    options?: ValidateCopyOptions,
  ) => Promise<CopyVerdict>;
  /** An existing copy handed directly to the verifier for a requested edit. */
  initialCopyDraft?: unknown;
  /** The copy's first draft, from the host's one request to the copy role
   * (copy.ts): the write stage runs no session. */
  draftCopy?: () => Promise<{ draft: unknown; usage: SessionUsage | null }>;
  /** The isolated environment every session of a stage runs with; written
   * once per stage by runStage. */
  codexEnv?: Record<string, string>;
  /** Persist settled files before another batch can start. */
  checkpoint?: (files?: readonly string[]) => Promise<void>;
  /** The host's asynchronous verdict on a structurally valid output, for a
   * stage whose descriptor asks for one (the author: identity, sources,
   * reachability). Errors resume the session with them; `fatal` ends the
   * batch without another attempt; `value` replaces the output. */
  verdict?: (value: StageValue) => Promise<{
    errors: string[];
    fatal?: boolean;
    value?: StageValue;
  }>;
  /** The research tool server a stage that registers one is given. */
  research?: ResearchServerConfig;
  /** The run journal: sessions and the host's decisions on their outputs
   * are recorded as they happen (specs/aeo-open-source-cli-spec.md §7). */
  recorder?: ExecutionRecorder;
};

export type ValidateCopyOptions = {
  round?: number;
  previousFindings?: readonly string[];
  reviewed?: (findings: readonly string[]) => Promise<void>;
};

export type CopyVerdict = {
  ok: boolean;
  fixable: boolean;
  outcome?: CopyValidationOutcome;
  errors: string[];
  /** The verifier's direct edit, which becomes its next review input. */
  editedDraft?: unknown;
  /** What the stage keeps when ok: the validated copy with its receipt. */
  payload?: Record<string, unknown>;
};

export type { StageValue } from './checks';

/** What the copy stage stores and delivers: the verifier's payload around
 * the draft it accepted. */
export type VerifiedCopy = { draft: unknown; [key: string]: unknown };

export const defaultBatchSize = 10;
export const defaultConcurrency = 25;
const maxAttempts = 3;

/** The files one Codex session works on. `<b>` in a prompt is this. */
export type Batch = {
  index: number;
  files: readonly AnswerFile[];
};

/** What one stage needs from the runner. Everything a stage does that
 * another does not is a field here, so adding a stage adds a row, not a
 * branch. */
type StageSpec = {
  /** Partitioned by answer file, or one session over the whole report. */
  batched: boolean;
  /** The calibrated workload a session is reserved at on the run's ledger
   * (src/models/cost-coefficients.ts). Absent for the stage that runs no
   * session: the copy's draft is one request (copy.ts). */
  sessionCost?: SessionCost;
  /** Judged against the batch's own files, or every answer (the copy must
   * name every configured section). */
  judgedOn: 'batch' | 'all';
  /** The batch's conversation is kept: a feedback round or a rerun resumes
   * it with its context, instead of every session starting fresh. */
  persistent: boolean;
  /** Files under the work directory every session reads; part of the
   * inputs digest. */
  sharedInputs: (dir: string) => Promise<string[]>;
  /** The per-batch file the host writes before a session, from what the
   * upstream stages produced for the batch's answers. `required` is false
   * when a digest asks before the upstream exists (nothing to reuse yet)
   * and true when a session is about to start. */
  input: (
    ctx: StageContext,
    batch: Batch,
    required: boolean,
  ) => Promise<{ name: string; content: unknown } | null>;
  /** What a session is piped: the batch packet (that input file, the
   * shared files and the answer bodies), or nothing for a stage that reads
   * the work directory itself. */
  packet: (args: {
    dir: string;
    index: number;
    answers: readonly AnswerFile[];
    sharedFiles: readonly string[];
    continuation: boolean;
  }) => Promise<string | null>;
  /** The output carries corrections the host applies upstream. */
  corrects: boolean;
  /** The host's asynchronous verdict decides the output, and the stored
   * batch file wraps the validated draft in the verdict's payload. */
  hostVerdict: boolean;
  /** A rerun keeps the previous output for the session to start from,
   * and the merged verdict decides whether accepted batches are reused. */
  passes: boolean;
  /** With no batch validated, the stage still delivers its empty output
   * with every answer degraded: no model judgment is still a measurement.
   * Off where an absent output must not pass for one (a review that never
   * returned is not an acceptance). */
  deliversUnjudged: boolean;
  /** The sandbox the session runs under: the stages' configured one, or
   * read-only regardless (the author, whose only egress is its tools). */
  sandbox: 'stage' | 'read-only';
  /** The isolated home registers the research tool server. */
  research: boolean;
  /** The host's asynchronous verdict (StageContext.verdict) decides
   * acceptance after the structural checks. */
  verdict: boolean;
  /** The shared files a retained conversation is bound to, when not all of
   * them: a file left out is appended to the resumed conversation instead
   * of starting a new one. */
  sessionInputs?: (files: readonly string[]) => string[];
};

// A stage output or batch file as the runner reads it: host-written and
// already validated. Rows pass through as written, key order included, since
// they are part of the batch inputs digest and are written back by
// corrections.
const rowsOutSchema = z.looseObject({
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
});

type Rows = z.infer<typeof rowsOutSchema>;

const readOut = async (
  dir: string,
  { stage, required }: { stage: StageName; required: boolean },
): Promise<Rows> => {
  const raw = await readFile(
    path.join(dir, 'OUT', `${stage}.json`),
    'utf8',
  ).catch(() => null);

  if (raw === null && required) {
    throw new Error(
      `OUT/${stage}.json is missing: the ${stage} stage runs first.`,
    );
  }

  return raw ? rowsOutSchema.parse(JSON.parse(raw)) : {};
};

const rowsOf = (batch: Batch, out: Rows) => {
  const files = new Set(batch.files.map((file) => file.file));

  return (out.rows ?? []).filter(
    (row) => typeof row.file === 'string' && files.has(row.file),
  );
};

const fixedInputs = (files: readonly string[]) => {
  return () => Promise.resolve([...files]);
};

const batchPacket = (
  stage: Exclude<StageName, 'write'>,
): StageSpec['packet'] => {
  return (args) => batchInput({ ...args, stage });
};

/** What every report stage shares; a row states only what differs. */
const reportStage = {
  sandbox: 'stage',
  research: false,
  verdict: false,
} as const;

const stageSpecs: Record<StageName, StageSpec> = {
  analyze: {
    ...reportStage,
    batched: true,
    sessionCost: 'answers',
    judgedOn: 'batch',
    persistent: false,
    sharedInputs: fixedInputs([
      'CONFIG.json',
      'RULES/analysis.md',
      'CRITERIA.md',
    ]),
    input: (_ctx, batch) =>
      Promise.resolve({
        name: `${batch.index}.index.json`,
        content: batch.files.map(({ body: _body, ...entry }) => entry),
      }),
    packet: batchPacket('analyze'),
    corrects: false,
    hostVerdict: false,
    passes: false,
    deliversUnjudged: true,
  },
  qualify: {
    ...reportStage,
    batched: true,
    sessionCost: 'answers',
    judgedOn: 'batch',
    persistent: false,
    sharedInputs: fixedInputs([
      'CONFIG.json',
      'RULES/analysis.md',
      'CRITERIA.md',
    ]),
    input: async (ctx, batch, required) => ({
      name: `${batch.index}.rows.json`,
      content: {
        rows: rowsOf(
          batch,
          await readOut(ctx.dir, { stage: 'analyze', required }),
        ),
      },
    }),
    packet: batchPacket('qualify'),
    corrects: true,
    hostVerdict: false,
    passes: false,
    deliversUnjudged: true,
  },
  review: {
    ...reportStage,
    batched: true,
    sessionCost: 'answers',
    judgedOn: 'batch',
    persistent: true,
    sharedInputs: fixedInputs([
      'CONFIG.json',
      'CRITERIA.md',
      'RULES/analysis.md',
    ]),
    input: async (ctx, batch, required) => ({
      name: `${batch.index}.rows.json`,
      content: {
        analyze: rowsOf(
          batch,
          await readOut(ctx.dir, { stage: 'analyze', required }),
        ),
        qualify: rowsOf(
          batch,
          await readOut(ctx.dir, { stage: 'qualify', required }),
        ),
      },
    }),
    packet: batchPacket('review'),
    corrects: true,
    hostVerdict: false,
    passes: true,
    deliversUnjudged: false,
  },
  write: {
    ...reportStage,
    batched: false,
    judgedOn: 'all',
    persistent: true,
    // Everything under COPY/, listed at digest time.
    sharedInputs: async (dir) => {
      const files: string[] = [];
      const walk = async (relative: string) => {
        for (const entry of await readdir(path.join(dir, relative), {
          withFileTypes: true,
        }).catch(() => [])) {
          if (entry.isDirectory()) {
            await walk(path.posix.join(relative, entry.name));
          } else {
            files.push(path.posix.join(relative, entry.name));
          }
        }
      };

      await walk(copyDir);

      return files.sort();
    },
    input: () => Promise.resolve(null),
    packet: () => Promise.resolve(null),
    corrects: false,
    hostVerdict: true,
    passes: false,
    deliversUnjudged: false,
  },
  // The config author (specs/aeo-codex-author-spec.md §3.1): one retained
  // session over the brief, researching through the host's tools under a
  // read-only sandbox, judged by the host's verdict after it submits.
  author: {
    batched: false,
    sessionCost: 'brief',
    judgedOn: 'all',
    persistent: true,
    sharedInputs: authorFiles,
    sessionInputs: authorSessionInputs,
    input: () => Promise.resolve(null),
    packet: ({ dir, continuation }) => authorPacket({ dir, continuation }),
    corrects: false,
    hostVerdict: false,
    passes: false,
    deliversUnjudged: false,
    sandbox: 'read-only',
    research: true,
    verdict: true,
  },
};

/** Token usage over several sessions; null when none reported any. */
const sumUsage = (usages: readonly StageRun['usage'][]): StageRun['usage'] => {
  const reported = usages.flatMap((usage) => (usage ? [usage] : []));

  if (!reported.length) {
    return null;
  }

  return {
    inputTokens: reported.reduce(
      (total, usage) => total + usage.inputTokens,
      0,
    ),
    cachedInputTokens: reported.reduce(
      (total, usage) => total + usage.cachedInputTokens,
      0,
    ),
    outputTokens: reported.reduce(
      (total, usage) => total + usage.outputTokens,
      0,
    ),
  };
};

const sha = (value: unknown): string => {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
};

export const partition = (
  answers: readonly AnswerFile[],
  size: number = defaultBatchSize,
): Batch[] => {
  if (size === Infinity) {
    return [{ index: 0, files: [] }];
  }

  const ordered = [...answers].sort(
    (a, b) =>
      a.sectionKey.localeCompare(b.sectionKey) ||
      a.promptId.localeCompare(b.promptId) ||
      a.surface.localeCompare(b.surface) ||
      a.runIndex - b.runIndex,
  );

  const batches: Batch[] = [];

  for (let at = 0; at < ordered.length; at += size) {
    batches.push({
      index: batches.length,
      files: ordered.slice(at, at + size),
    });
  }

  return batches;
};

const stageBatches = (ctx: StageContext, stage: StageName): Batch[] => {
  if (
    stageSpecs[stage].batched &&
    ctx.batchLayout?.size === (ctx.batchSize ?? defaultBatchSize)
  ) {
    const answers = new Map(ctx.answers.map((answer) => [answer.file, answer]));

    return ctx.batchLayout.batches.map((files, index) => ({
      index,
      files: files.flatMap((file) => answers.get(file) ?? []),
    }));
  }

  return partition(
    ctx.answers,
    stageSpecs[stage].batched ? ctx.batchSize : Infinity,
  );
};

const scopeFor = (
  ctx: StageContext,
  stage: StageName,
  batch: Batch,
): CheckScope => {
  return {
    brand: ctx.brand,
    answers: stageSpecs[stage].judgedOn === 'all' ? ctx.answers : batch.files,
    sections: ctx.sections,
    ownedDomains: ctx.ownedDomains,
    coverage: true,
  };
};

const batchInputsDigest = async (
  ctx: StageContext,
  stage: StageName,
  batch: Batch,
): Promise<string> => {
  const spec = stageSpecs[stage];
  const parts: Record<string, string> = {
    model: JSON.stringify(codexStageConfig(ctx.stageModel)),
    prompt: stagePrompts[stage],
    version: String(stageVersions[stage]),
    schema: JSON.stringify(stageJsonSchema(stage)),
    rows: JSON.stringify(
      (await spec.input(ctx, batch, false))?.content ?? null,
    ),
  };

  for (const file of await spec.sharedInputs(ctx.dir)) {
    parts[file] = await readFile(path.join(ctx.dir, file), 'utf8').catch(
      () => '',
    );
  }

  for (const answer of batch.files) {
    parts[answer.file] = sha(answer.body);
  }

  return sha(parts);
};

/** What a stage's output depends on: every batch's digest, in order. A
 * resume reruns a stage only when this changed, and within it only the
 * batches whose own digest changed. */
export const stageInputsDigest = async (
  ctx: StageContext,
  stage: StageName,
): Promise<string> => {
  const digests: string[] = [];

  for (const batch of stageBatches(ctx, stage)) {
    digests.push(await batchInputsDigest(ctx, stage, batch));
  }

  return sha(digests);
};

export const isStageFresh = async (
  ctx: StageContext,
  stage: StageName,
): Promise<boolean> => {
  const recorded = await readFile(
    path.join(ctx.dir, 'OUT', `${stage}.inputs.sha`),
    'utf8',
  ).catch(() => null);

  if (!recorded) {
    return false;
  }

  const out = await readFile(
    path.join(ctx.dir, 'OUT', `${stage}.json`),
    'utf8',
  ).catch(() => null);

  return (
    out !== null && recorded.trim() === (await stageInputsDigest(ctx, stage))
  );
};

/** The stages' own sandbox setting: AEO_CODEX_SANDBOX governs the probes,
 * and the report container must not widen those. The author runs read-only
 * whatever the setting: its tools are its only egress and its only pen. */
const sessionSandbox = (spec: StageSpec) => {
  if (spec.sandbox === 'read-only') {
    return 'read-only';
  }

  const AEO_CODEX_STAGE_SANDBOX = readEnv('AEO_CODEX_STAGE_SANDBOX');

  return AEO_CODEX_STAGE_SANDBOX === 'danger-full-access'
    ? 'danger-full-access'
    : 'workspace-write';
};

// The fields of a `codex exec --json` event the runner reads; every other
// field passes through to the journal untouched. A field of an unexpected
// type reads as absent, so the rest of the event still counts.
const eventText = z.string().optional().catch(undefined);
const eventTokens = z.number().optional().catch(undefined);
const eventUsage = z
  .looseObject({
    input_tokens: eventTokens,
    cached_input_tokens: eventTokens,
    output_tokens: eventTokens,
  })
  .optional()
  .catch(undefined);

const codexEventSchema = z.looseObject({
  type: eventText,
  thread_id: eventText,
  message: eventText,
  error: z.looseObject({ message: eventText }).optional().catch(undefined),
  item: z
    .looseObject({
      type: eventText,
      command: eventText,
      text: eventText,
      status: eventText,
    })
    .optional()
    .catch(undefined),
  usage: eventUsage,
  info: z
    .looseObject({ total_token_usage: eventUsage })
    .optional()
    .catch(undefined),
});

type CodexEvent = z.infer<typeof codexEventSchema>;

type CodexItem = NonNullable<CodexEvent['item']>;

/** One stdout line as an event; undefined for progress text and other
 * lines that are not an event object. */
const parseCodexEvent = (line: string): CodexEvent | undefined => {
  let json: unknown;

  try {
    json = JSON.parse(line);
  } catch {
    // Non-JSON lines are progress text.
    return undefined;
  }

  const parsed = codexEventSchema.safeParse(json);

  return parsed.success ? parsed.data : undefined;
};

/** A completed Codex action as one line of the live log. */
const describeItem = (item: CodexItem) => {
  if (item.type === 'command_execution') {
    return `ran: ${(item.command ?? '').slice(0, 100)}`;
  }

  if (item.type === 'agent_message') {
    return `said: ${(item.text ?? '').replace(/\s+/g, ' ').slice(0, 140)}`;
  }

  if (item.type === 'reasoning') {
    return 'reasoned';
  }

  return item.type ?? 'item';
};

type SessionTarget = {
  stage: StageName;
  batch: Batch;
  feedback: SessionPromptOptions;
  attempt?: number;
};

type SessionCharge = {
  settle: (usage: SessionUsage | null) => Promise<void>;
};

/** reserveSession charges one session to the run's ledger before it starts,
 * at the high estimate for its stage's workload, and returns how to settle
 * it from the tokens it reports at the stage model's list prices. A session
 * that reports nothing is settled without a cost, so it keeps charging its
 * reservation: nothing is recorded that Codex did not report. */
const reserveSession = async (
  ctx: StageContext,
  { stage, batch, attempt }: Pick<SessionTarget, 'stage' | 'batch' | 'attempt'>,
): Promise<SessionCharge | undefined> => {
  const { accounting, stageModel } = ctx;

  if (!accounting) {
    return undefined;
  }

  const { sessionCost } = stageSpecs[stage];

  if (sessionCost === undefined) {
    throw new Error(`The ${stage} stage runs no session to reserve.`);
  }

  const pricing = stageModel.pricingUsdPerMillion;
  const reserved = sessionReservation({
    cost: sessionCost,
    answers: batch.files.length,
  });
  // Unique per session: a resumed run never settles a session it lost
  // under the old one's reservation.
  const callId = `codex:${stage}-${batch.index}:${attempt ?? 1}:${randomUUID()}`;

  await accounting.reserve({
    callId,
    role: `stage:${stage}`,
    requestedModel: stageModel.model,
    reasoningEffort: stageModel.reasoningEffort,
    reservedUsd: tokenCostUsd(pricing, reserved),
    inputTokens: reserved.inputTokens,
    maxOutputTokens: reserved.outputTokens,
  });

  const charge: SessionCharge = {
    settle: async (usage) => {
      await accounting.settle(
        callId,
        usage
          ? {
              requestedModel: stageModel.model,
              costUsd: tokenCostUsd(pricing, usage),
              inputTokens: usage.inputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              outputTokens: usage.outputTokens,
            }
          : { requestedModel: stageModel.model, valid: false },
      );
    },
  };

  return charge;
};

type SessionResult = Awaited<ReturnType<typeof execReservedCodex>>;

/** Run one session of a batch once the run's cap can hold its reservation
 * (session-gate.ts), and tell the gate when it is over. */
const execCodex = async (
  ctx: StageContext,
  target: SessionTarget,
): Promise<SessionResult> => {
  let held: { ended: () => void } | undefined;
  const reserve = async () => {
    if (!ctx.accounting) {
      return undefined;
    }

    const session = await reserveWhenAffordable(
      ctx.accounting,
      () => reserveSession(ctx, target),
      ctx.signal,
    );

    held = session;

    return session.charge;
  };

  try {
    return await execReservedCodex(ctx, target, reserve);
  } finally {
    held?.ended();
  }
};

/** Run `codex exec` for one session of a batch: a fresh conversation, or
 * the batch's saved one when the stage keeps it and the contract (what the
 * conversation has read) is unchanged. */
const execReservedCodex = async (
  ctx: StageContext,
  { stage, batch, feedback, attempt }: SessionTarget,
  reserve: () => Promise<SessionCharge | undefined>,
): Promise<{
  usage: StageRun['usage'];
  exitCode: number;
  stderr: string;
  /** The API's own error when the turn failed; stderr holds only noise. */
  failure: string | null;
  /** The session resumed the batch's saved conversation. */
  resumed: boolean;
  /** The session's operation in the run journal, when the run records. */
  operationId?: string;
}> => {
  // The child is not a Node process of ours and gets exactly the isolated
  // set. Next.js's global ProcessEnv type requires NODE_ENV, which that set
  // rightly leaves out.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Next.js types every ProcessEnv with a required NODE_ENV.
  const env = ctx.codexEnv as NodeJS.ProcessEnv;
  // No structured-output mode: told that its final message must be the
  // object, a small model answers at once without reading a file. The
  // stage writes its batch output itself and the host validates it.
  const spec = stageSpecs[stage];
  const label = `${stage}-${batch.index}`;
  const sharedFiles = await spec.sharedInputs(ctx.dir);
  // A conversation is resumed only over what it has already read: the
  // stage's rules (its version), prompts, schema, shared files and answers.
  // A stage may leave files out of the contract (the author's PREVIOUS/):
  // those are appended to the resumed conversation instead.
  const boundFiles = spec.sessionInputs?.(sharedFiles) ?? sharedFiles;
  const contract = sha({
    stage,
    version: stageVersions[stage],
    model: codexStageConfig(ctx.stageModel),
    prompt: stagePrompts[stage],
    continuation: sessionPrompt(stage, batch.index, { continuation: true }),
    schema: stageJsonSchema(stage),
    answers: batch.files.map(({ file, body }) => [file, sha(body)]),
    inputs: await Promise.all(
      boundFiles.map(async (file) => [
        file,
        await readFile(path.join(ctx.dir, file), 'utf8').catch(() => ''),
      ]),
    ),
  });

  const session = spec.persistent
    ? await readSession(ctx.dir, { label, contract })
    : null;
  const instruction = sessionPrompt(stage, batch.index, {
    ...feedback,
    continuation: session !== null,
  });

  const input = await spec.packet({
    dir: ctx.dir,
    index: batch.index,
    answers: batch.files,
    sharedFiles,
    continuation: session !== null,
  });

  // Unlike a new exec, exec resume ignores piped context beside an argv
  // prompt. Its explicit stdin mode must carry both instructions and rows.
  const resumeInput = session && input !== null;
  const stdin = resumeInput ? `${instruction}\n\n${input}` : input;
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...(!spec.persistent ? ['--ephemeral'] : []),
    '--sandbox',
    sessionSandbox(spec),
    '--cd',
    ctx.dir,
    ...(session ? ['resume', session.threadId] : []),
    resumeInput ? '-' : instruction,
  ];

  let threadId: string | null = session?.threadId ?? null;
  const codexBinary = ctx.command
    ? codexBinaryAt(ctx.command)
    : resolveCodexBinary();

  ctx.signal?.throwIfAborted();

  // Reserved before the child starts: a session the cap cannot afford is
  // never started. It waits while another session may still give budget
  // back; otherwise the run stops resumable at its budget.
  const charge = await reserve();

  // Recorded before the child starts: a session the host loses track of
  // stays an open operation, an unknown outcome, never a silent success.
  const operation = await ctx.recorder?.start({
    kind: 'codex_session',
    stage,
    batch: batch.index,
    ...(attempt !== undefined && { attempt }),
    inputs: {
      instruction,
      stdin: stdin ?? undefined,
      arguments: JSON.stringify(args),
    },
    details: {
      requestedModel: ctx.stageModel.model,
      provider: codexGateway.providerName,
      reasoningEffort: ctx.stageModel.reasoningEffort,
      codex: { source: codexBinary.source, version: codexBinary.version },
      sandbox: sessionSandbox(spec),
      resumedThreadId: session?.threadId ?? null,
    },
  });
  const transcript: string[] = [];

  const result = await new Promise<{
    usage: StageRun['usage'];
    exitCode: number;
    stderr: string;
    failure: string | null;
  }>((resolve) => {
    // Codex appends piped input to the instruction as context. End the pipe
    // immediately after the complete packet; an open stdin waits forever.
    const child = spawn(codexBinary.command, codexArgs(codexBinary, args), {
      cwd: ctx.dir,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const abort = () => {
      failure = 'the host stopped the work';
      killChildProcessGroup(child, 'SIGKILL');
    };

    ctx.signal?.addEventListener('abort', abort, { once: true });

    let usage: StageRun['usage'] = null;
    let buffer = '';
    let stderr = '';
    let failure: string | null = null;

    child.stdin.on('error', (error) => {
      failure = `could not deliver batch input: ${error.message}`;
      killChildProcessGroup(child, 'SIGKILL');
    });
    child.stdin.end(stdin ?? undefined);

    // The event stream is the only live view of a batch: every line is kept
    // in the journal, and each completed action is echoed with a clock so
    // an operator watching the log sees what Codex is doing.
    const events = createWriteStream(
      path.join(ctx.dir, 'JOURNAL', `${label}.events.jsonl`),
      { flags: 'a' },
    );

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      let at = buffer.indexOf('\n');

      while (at >= 0) {
        const line = buffer.slice(0, at);

        buffer = buffer.slice(at + 1);
        events.write(`${line}\n`);
        transcript.push(line);

        const event = parseCodexEvent(line);

        if (event?.type === 'thread.started' && event.thread_id) {
          threadId = event.thread_id;
        }

        const found = event?.usage ?? event?.info?.total_token_usage;

        if (found) {
          usage = {
            inputTokens: found.input_tokens ?? 0,
            cachedInputTokens: found.cached_input_tokens ?? 0,
            outputTokens: found.output_tokens ?? 0,
          };
        }

        if (event?.type === 'turn.failed' || event?.type === 'error') {
          failure = event.error?.message ?? event.message ?? failure;
        }

        if (event?.type === 'item.completed' && event.item) {
          printProgress(`${label} ${describeItem(event.item)}`);
        }

        at = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeoutMs = ctx.timeoutMs ?? 20 * 60_000;
    const timer = setTimeout(() => {
      failure = `the session exceeded ${Math.round(timeoutMs / 1000)}s and was killed`;
      killChildProcessGroup(child, 'SIGKILL');
    }, timeoutMs);

    child.on('error', (error) => {
      failure = error.message;
    });
    child.on('close', (code) => {
      killChildProcessGroup(child, 'SIGKILL');
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', abort);
      events.end();
      resolve({ usage, exitCode: code ?? 1, stderr, failure });
    });
  });

  // The CLI's event stream as the adapter saw it; the session usage is the
  // CLI's own total, never split into invented per-request calls.
  await operation?.finish({
    outcome:
      result.exitCode === 0 && result.failure === null ? 'succeeded' : 'failed',
    outputs: {
      events: transcript.length ? `${transcript.join('\n')}\n` : undefined,
    },
    details: {
      exitCode: result.exitCode,
      failure: result.failure,
      threadId,
      sessionUsage: result.usage,
    },
  });

  await charge?.settle(result.usage);

  if (spec.persistent && threadId) {
    const files = await saveSession(ctx.dir, label, { contract, threadId });

    await ctx.checkpoint?.(files);
  }

  return {
    ...result,
    resumed: session !== null,
    ...(operation && { operationId: operation.id }),
  };
};

/** A correction field is a path into the row: `prospectMentioned`,
 * `mentionedBrands`, or a nested `qualifiedCompetitors[0].quote` (the
 * scrutiny pass of run C fixed a quote that way and the host refused it
 * as an unknown key, 2026-09-13). */
export const fieldPath = (field: string): string[] => {
  return field
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
};

const readPath = (
  row: Record<string, unknown>,
  segments: readonly string[],
): unknown => {
  let at: unknown = row;

  for (const segment of segments) {
    if (!isObject(at)) {
      return undefined;
    }

    at = at[segment];
  }

  return at;
};

type PathWrite = {
  segments: readonly string[];
  value: unknown;
};

/** Sets the value at the path; false when the path does not exist in the row. */
const writePath = (
  row: Record<string, unknown>,
  { segments, value }: PathWrite,
): boolean => {
  const parent = readPath(row, segments.slice(0, -1));
  const last = segments[segments.length - 1];

  if (!isObject(parent) || last === undefined || !(last in parent)) {
    return false;
  }

  parent[last] = value;

  return true;
};

/** A correction value is JSON text; a bare word the model did not quote
 * (`listed`, `true`) is taken as the string it is. */
export const correctionValue = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const readCorrectable = async (file: string) => {
  const raw = await readFile(file, 'utf8');

  return rowsOutSchema.parse(JSON.parse(raw));
};

const isQualifyRow = (
  row: Record<string, unknown>,
): row is Record<string, unknown> & QualifyOutput['rows'][number] => {
  return qualifyRowSchema.safeParse(row).success;
};

type CorrectionOutcome = { correction: Correction; outcome: string };

type CorrectionScope = {
  stage: StageName;
  scope: CheckScope;
  answers: readonly AnswerFile[];
};

/** One correction against the output as it stands: the output it leaves
 * (reconciled by the host rules when applied) and what came of it. */
const applyCorrection = (
  output: Rows,
  correction: Correction,
  { stage, scope, answers }: CorrectionScope,
): { output: Rows; outcome: string; applied: boolean } => {
  const row = output.rows?.find((entry) => entry.file === correction.file);

  if (!row) {
    return {
      output,
      outcome: 'refused: no row for that file',
      applied: false,
    };
  }

  const segments = fieldPath(correction.field);
  const before = readPath(row, segments);
  const next = correctionValue(correction.to);

  if (!writePath(row, { segments, value: next })) {
    return {
      output,
      outcome: `refused: no field ${correction.field} on that row`,
      applied: false,
    };
  }

  const validated = validateStage(scope, stage, output);

  if (validated.value === undefined || validated.errors.length) {
    writePath(row, { segments, value: before });

    return {
      output,
      outcome: `refused: ${validated.errors[0] ?? 'the output is invalid'}`,
      applied: false,
    };
  }

  const reconciled = rowsOutSchema.parse(validated.value);
  const after = readPath(
    reconciled.rows?.find((entry) => entry.file === correction.file) ?? {},
    segments,
  );

  // Restoring source punctuation is mechanical, not a reversal of the
  // reviewer's judgment. Entity removal or other rule changes still refuse it.
  // The row keeps its written key order, which the comparison below sees.
  const expected =
    stage === 'qualify' && isQualifyRow(row)
      ? readPath(
          restoreQualificationQuotes(
            row,
            answers.find((answer) => answer.file === correction.file)?.body ??
              '',
          ),
          segments,
        )
      : next;

  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    // The rules reversed part of it: the file stays exactly as it was.
    writePath(row, { segments, value: before });

    return {
      output,
      outcome: 'refused: the host rules reverse it',
      applied: false,
    };
  }

  return { output: reconciled, outcome: 'applied', applied: true };
};

/** A later partial rerun merges cached batches. Their rows are kept aligned
 * with the corrected aggregate so that merge cannot restore old evidence. */
const alignBatchRows = async (batchDir: string, output: Rows) => {
  const rows = new Map(output.rows?.map((row) => [row.file, row]));
  const names = await readdir(batchDir).catch((): string[] => []);

  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue;
    }

    const batchFile = path.join(batchDir, name);
    const batch = await readCorrectable(batchFile);

    if (!batch.rows) {
      continue;
    }

    batch.rows = batch.rows.map((row) => rows.get(row.file) ?? row);
    await writeFile(batchFile, JSON.stringify(batch, null, 2));
  }
};

/** Apply a later stage's corrections to the OUT file they name, keeping
 * the audit trail in OUT/corrections.json. A corrected output is held to
 * the same row rules as a fresh one, not to batch coverage: a correction
 * the rules reverse, in whole or in part (the qualify stage re-listing the
 * prospect's runtime alias on rows that mark the prospect absent), is
 * refused, recorded, and leaves the file exactly as it was. */
export const applyCorrections = async (
  ctx: Pick<
    StageContext,
    'dir' | 'brand' | 'answers' | 'allAnswers' | 'recorder'
  >,
  from: StageName,
  corrections: readonly Correction[],
): Promise<{ applied: number; refused: number }> => {
  let applied = 0;
  let refused = 0;
  const outcomes: CorrectionOutcome[] = [];
  const byStage = new Map<string, Correction[]>();

  for (const correction of corrections) {
    byStage.set(correction.stage, [
      ...(byStage.get(correction.stage) ?? []),
      correction,
    ]);
  }

  // Against every answer of the run: a row of a file that a later batch
  // degraded is still a row, and a correction to it still applies.
  const answers = ctx.allAnswers ?? ctx.answers;
  const scope: CheckScope = { brand: ctx.brand, answers, coverage: false };

  for (const [stage, list] of byStage) {
    const file = path.join(ctx.dir, 'OUT', `${stage}.json`);
    const raw = await readFile(file, 'utf8').catch(() => null);

    if (!raw || !isStageName(stage)) {
      for (const correction of list) {
        outcomes.push({ correction, outcome: 'refused: no such stage output' });
      }

      refused += list.length;
      continue;
    }

    let output = rowsOutSchema.parse(JSON.parse(raw));

    for (const correction of list) {
      const result = applyCorrection(output, correction, {
        stage,
        scope,
        answers,
      });

      output = result.output;

      if (result.applied) {
        applied += 1;
      } else {
        refused += 1;
      }

      outcomes.push({ correction, outcome: result.outcome });
    }

    await writeFile(file, JSON.stringify(output, null, 2));
    await alignBatchRows(path.join(ctx.dir, 'OUT', stage), output);
  }

  const trailFile = path.join(ctx.dir, 'OUT', 'corrections.json');
  const trail = z
    .array(z.unknown())
    .parse(
      JSON.parse((await readFile(trailFile, 'utf8').catch(() => '[]')) || '[]'),
    );

  const at = new Date().toISOString();

  trail.push(
    ...outcomes.map(({ correction, outcome }) => ({
      by: from,
      at,
      outcome,
      ...correction,
    })),
  );
  await writeFile(trailFile, JSON.stringify(trail, null, 2));

  // The trail file is replaced as corrections accumulate; the journal keeps
  // each host decision, in order, as it was made (spec §7.3).
  for (const { correction, outcome } of outcomes) {
    await ctx.recorder?.record(
      outcome === 'applied' ? 'correction_applied' : 'correction_refused',
      { by: from, outcome, ...correction },
    );
  }

  return { applied, refused };
};

/** A rerun starts with clean notes: the previous run's notes are kept
 * under a timestamp, so a session never reads notes about a state that no
 * longer exists as if they were its own. */
const archiveNotes = async (dir: string, label: string) => {
  const notes = path.join(dir, 'JOURNAL', `${label}.md`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  await rename(notes, path.join(dir, 'JOURNAL', `${label}.${stamp}.md`)).catch(
    () => undefined,
  );
};

type BatchRun = {
  batch: Batch;
  ok: boolean;
  reused: boolean;
  /** Sessions for a Codex batch; editorial rounds for the copy. */
  attempts: number;
  /** Outputs the host refused; process and unavailable-verifier failures
   * are not refusals. */
  refusals: number;
  usage: StageRun['usage'];
  errors: string[];
  value?: StageValue;
  /** The accepted copy of a stage decided by the host's verdict. */
  copy?: VerifiedCopy;
  correctionsApplied?: boolean;
  /** See `StageRun.fatal`. */
  fatal?: string;
};

/** What a batch's sessions came to: the accepted output, or the errors
 * that stood when the attempts ran out. */
type Attempted = Pick<
  BatchRun,
  'attempts' | 'refusals' | 'usage' | 'errors' | 'value' | 'copy' | 'fatal'
>;

/** Where one batch's files live. */
type BatchFiles = {
  label: string;
  digest: string;
  outFile: string;
  /** A refused output, moved aside for the next session to repair, so a
   * session that writes nothing is never judged on it. */
  refusedFile: string;
};

/** One batch of a stage and where its files live. */
type BatchTarget = {
  stage: StageName;
  batch: Batch;
  files: BatchFiles;
};

const clock = () => {
  return new Date().toISOString().slice(11, 19);
};

/** A clocked line of live progress for an operator tailing the run. */
const printProgress = (line: string) => {
  // eslint-disable-next-line no-console -- The live batch log is the CLI's and the job's terminal output, read as printed.
  console.log(`${clock()} ${line}`);
};

/** One line in a batch's journal, checkpointed: what an operator or a
 * replacement worker needs to know about an attempt. */
const journal = async (
  ctx: StageContext,
  {
    label,
    file,
    entry,
  }: {
    label: string;
    file: 'failures' | 'refusals';
    entry: Record<string, unknown>;
  },
) => {
  const relative = `JOURNAL/${label}.${file}.jsonl`;

  await appendFile(
    path.join(ctx.dir, relative),
    `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`,
  );
  await ctx.checkpoint?.([relative]);
};

/** A session that ended without its output file; retried on the same
 * count when attempts remain. */
const recordIncomplete = async (
  ctx: StageContext,
  {
    label,
    attempt,
    retrying,
    error,
  }: { label: string; attempt: number; retrying: boolean; error: string },
) => {
  printProgress(
    `${label} failed (attempt ${attempt}${retrying ? ', retrying' : ''}): ${error}`,
  );
  await journal(ctx, {
    label,
    file: 'failures',
    entry: { attempt, retrying, errors: [error] },
  });
};

/** The scorecard counts refusals; the reasons go to the journal and the
 * live log, so a run compared across days can say what went back and an
 * operator tailing the log sees it as it happens. */
const recordRefusal = async (
  ctx: StageContext,
  {
    label,
    attempt,
    errors,
  }: { label: string; attempt: number; errors: readonly string[] },
) => {
  const reasons = errors.slice(0, 20);

  printProgress(
    `${label} refused (attempt ${attempt}): ${reasons.join('; ').slice(0, 600)}`,
  );
  await journal(ctx, {
    label,
    file: 'refusals',
    entry: { attempt, errors: reasons },
  });
};

/** A resumed conversation that produced nothing (its rollout gone, the
 * thread expired) is not resumed again. */
const dropSession = async (ctx: StageContext, label: string) => {
  printProgress(
    `${label}: the resumed conversation produced no output; the next session starts fresh`,
  );

  // Two statements: an optional call skips its arguments when absent.
  const files = await forgetSession(ctx.dir, label);

  await ctx.checkpoint?.(files);
};

const incompleteError = (result: {
  exitCode: number;
  failure: string | null;
  stderr: string;
}): string => {
  return `codex exited ${result.exitCode} without an output file: ${(result.failure ?? result.stderr).slice(-600)}`;
};

const storedBatchSchema = z.record(z.string(), z.unknown());

/** A Codex batch: sessions until the host accepts the output file, each
 * refusal fed back to the next, at most maxAttempts. */
const runCodexBatch = async (
  ctx: StageContext,
  { stage, batch, files, scope }: BatchTarget & { scope: CheckScope },
): Promise<Attempted> => {
  const { label, outFile, refusedFile } = files;
  const usages: StageRun['usage'][] = [];
  let errors: string[] = [];
  let refusals = 0;
  let attempt = 0;
  let fatal: string | undefined;
  let feedback: SessionPromptOptions = {};

  while (attempt < maxAttempts) {
    ctx.signal?.throwIfAborted();
    attempt += 1;

    const result = await execCodex(ctx, { stage, batch, feedback, attempt });
    const decision = {
      stage,
      batch: batch.index,
      attempt,
      operationId: result.operationId ?? null,
    };

    usages.push(result.usage);

    const raw = await readFile(outFile, 'utf8').catch(() => null);

    if (raw === null) {
      const error = incompleteError(result);

      // The provider's verdict on the key reaches us only as the CLI's
      // error text. A rejected credential fails every session the same
      // way, so the sessions left are not spent on it.
      if (isAuthError(result.failure ?? result.stderr)) {
        fatal = 'auth';
      }

      const retrying =
        !ctx.signal?.aborted && attempt < maxAttempts && fatal === undefined;

      errors = [error];
      await recordIncomplete(ctx, { label, attempt, retrying, error });

      if (result.resumed) {
        await dropSession(ctx, label);
      }

      if (!retrying) {
        break;
      }

      feedback = { incomplete: true };
      continue;
    }

    if (result.exitCode !== 0) {
      printProgress(
        `${label}: CLI exited ${result.exitCode}; validating its saved output`,
      );
    }

    let output: unknown;

    try {
      output = JSON.parse(raw);
    } catch {
      errors = ['the output file is not JSON'];
      break;
    }

    const validated = validateStage(scope, stage, output);
    let value = validated.value;

    errors = validated.errors;

    if (value !== undefined && !errors.length && stageSpecs[stage].verdict) {
      if (!ctx.verdict) {
        throw new Error(`The ${stage} stage needs the host's verdict.`);
      }

      const judged = await ctx.verdict(value);

      errors = judged.errors;

      if (judged.value !== undefined) {
        value = judged.value;
      }

      if (judged.fatal) {
        // Not a repair: the submission is about the wrong company, or
        // carries a credential. The batch ends with the reason.
        refusals += 1;
        await recordRefusal(ctx, { label, attempt, errors });
        await ctx.recorder?.record(
          'output_refused',
          { ...decision, errors, fatal: true },
          { output: raw },
        );
        await rename(outFile, refusedFile);
        break;
      }
    }

    if (value !== undefined && !errors.length) {
      await ctx.recorder?.record('output_accepted', decision, {
        output: raw,
      });

      return {
        value,
        attempts: attempt,
        refusals,
        usage: sumUsage(usages),
        errors: [],
      };
    }

    refusals += 1;
    await recordRefusal(ctx, { label, attempt, errors });
    await ctx.recorder?.record(
      'output_refused',
      { ...decision, errors },
      { output: raw },
    );
    await rename(outFile, refusedFile);
    feedback = { refusal: errors };
  }

  return {
    attempts: attempt,
    refusals,
    usage: sumUsage(usages),
    errors,
    ...(fatal !== undefined && { fatal }),
  };
};

/** The verifier's checkpoint for a copy batch: the draft it holds, the
 * findings on it (empty: not yet reviewed) and the editorial rounds
 * consumed, which only a real recheck refusal consumes. Written after every
 * paid step, so a retry or a replacement worker resumes at the next step
 * and never repeats one whose result is on disk. */
const pendingSchema = z.object({
  version: z.literal(2).optional(),
  digest: z.string(),
  // A draft the writer never produced is absent from the written file.
  draft: z.unknown().optional(),
  rounds: z.number(),
  errors: z.array(z.string()),
});

type Pending = z.infer<typeof pendingSchema>;

type PendingFile = {
  label: string;
  pendingFile: string;
  digest: string;
};

const savePending = async (
  ctx: StageContext,
  { pendingFile, pending }: { pendingFile: string; pending: Pending },
) => {
  await writePendingJson(path.join(ctx.dir, pendingFile), pending);
  await ctx.checkpoint?.([pendingFile]);
};

/** The saved checkpoint, when it is about this batch's current inputs.
 * Older checkpoints counted unavailable checks as rounds; they are
 * recounted from the journal once. */
const readPending = async (
  ctx: StageContext,
  { label, pendingFile, digest }: PendingFile,
): Promise<Pending | null> => {
  const raw = await readFile(path.join(ctx.dir, pendingFile), 'utf8').catch(
    () => 'null',
  );
  const parsed = pendingSchema.safeParse(JSON.parse(raw));

  if (!parsed.success || parsed.data.digest !== digest) {
    return null;
  }

  const saved = parsed.data;

  if (saved.version === 2) {
    return saved;
  }

  const journalText = await readFile(
    path.join(ctx.dir, 'JOURNAL', `${label}.refusals.jsonl`),
    'utf8',
  ).catch(() => '');

  const pending: Pending = {
    ...saved,
    ...recoverEditorialRounds(saved, journalText),
    version: 2,
  };

  await savePending(ctx, { pendingFile, pending });

  return pending;
};

/** The copy's first draft: one request to the copy role, asked again only
 * when it failed without a draft. A request the role cannot carry, a spent
 * budget and a stopped run are not asked again. */
const writeInitialDraft = async (
  ctx: StageContext,
  { files, usages }: BatchTarget & { usages: StageRun['usage'][] },
): Promise<unknown> => {
  const { label } = files;

  if (!ctx.draftCopy) {
    throw new Error(`Copy draft has no writer: ${label}.`);
  }

  for (let attempt = 1; ; attempt += 1) {
    ctx.signal?.throwIfAborted();

    try {
      const { draft, usage } = await ctx.draftCopy();

      usages.push(usage);

      return draft;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retrying =
        !ctx.signal?.aborted &&
        !(error instanceof ModelBudgetError) &&
        message !== 'model_input_limit' &&
        attempt < maxAttempts;

      await recordIncomplete(ctx, { label, attempt, retrying, error: message });

      if (!retrying) {
        throw error;
      }
    }
  }
};

/** Transport and budget failures never consume an editorial round: the
 * verdict is asked again, up to maxAttempts, each time from the checkpoint
 * as it then stands, and thrown when it stays unavailable. */
const copyVerdict = async (
  ctx: StageContext,
  { label, ask }: { label: string; ask: () => Promise<CopyVerdict> },
): Promise<CopyVerdict> => {
  for (let attempt = 1; ; attempt += 1) {
    const verdict = await ask();

    if (verdict.ok || (verdict.fixable && verdict.editedDraft !== undefined)) {
      return verdict;
    }

    const outcome =
      verdict.outcome &&
      verdict.outcome !== 'valid' &&
      verdict.outcome !== 'invalid_copy'
        ? verdict.outcome
        : 'verifier_unavailable';

    const retrying =
      attempt < maxAttempts &&
      (outcome === 'verifier_unavailable' || outcome === 'invalid_review');

    printProgress(
      `${label} verification unavailable (${outcome}${retrying ? ', retrying' : ''}); editorial rounds unchanged`,
    );
    await journal(ctx, {
      label,
      file: 'failures',
      entry: {
        phase: 'verification',
        attempt,
        outcome,
        retrying,
        errors: verdict.errors,
      },
    });

    if (!retrying) {
      throw new CopyVerificationUnavailableError(outcome, verdict.errors);
    }

    await delay(attempt * 1000, undefined, { signal: ctx.signal });
  }
};

/** The copy: one writer session for the initial draft (or the draft handed
 * in for a requested edit), then the host's verifier owns every edit and
 * recheck, at most maxReviewRounds editorial rounds. The implementer is
 * never called again once a draft exists. */
const runVerifiedCopy = async (
  ctx: StageContext,
  {
    stage,
    batch,
    files,
    validateCopy,
  }: BatchTarget & {
    validateCopy: NonNullable<StageContext['validateCopy']>;
  },
): Promise<Attempted> => {
  const { label, digest } = files;
  const pendingFile = `PENDING/${label}.json`;
  const usages: StageRun['usage'][] = [];

  const start = async (): Promise<Pending> => {
    const draft =
      ctx.initialCopyDraft !== undefined
        ? ctx.initialCopyDraft
        : await writeInitialDraft(ctx, { stage, batch, files, usages });

    const pending: Pending = {
      version: 2,
      digest,
      draft,
      rounds: 0,
      errors: [],
    };

    await savePending(ctx, { pendingFile, pending });

    return pending;
  };

  let pending: Pending =
    (await readPending(ctx, { label, pendingFile, digest })) ?? (await start());

  const persist = async (next: Pending) => {
    pending = next;
    await savePending(ctx, { pendingFile, pending: next });
  };

  let copy: VerifiedCopy | undefined;
  let refusals = 0;
  let round = pending.rounds;

  while (round < maxReviewRounds) {
    round += 1;
    ctx.signal?.throwIfAborted();

    const verdict = await copyVerdict(ctx, {
      label,
      ask: () =>
        // The initial review's findings are persisted before the paid edit,
        // so a retry after a failed recheck resumes from them.
        validateCopy(pending.draft, {
          round,
          previousFindings: pending.errors,
          reviewed: (findings) =>
            persist({ ...pending, errors: [...findings] }),
        }),
    });

    if (verdict.ok) {
      copy = {
        ...verdict.payload,
        draft: verdict.editedDraft ?? pending.draft,
      };
      break;
    }

    refusals += 1;
    await persist({
      ...pending,
      draft: verdict.editedDraft,
      rounds: round,
      errors: [...verdict.errors],
    });
    await recordRefusal(ctx, { label, attempt: round, errors: verdict.errors });
  }

  return {
    copy,
    attempts: copy === undefined ? pending.rounds : round,
    refusals,
    usage: sumUsage(usages),
    errors: copy === undefined ? [...pending.errors] : [],
  };
};

/** A batch output kept from an earlier run, when its inputs are unchanged
 * and it still validates. */
const reusedBatch = async (
  ctx: StageContext,
  {
    stage,
    batch,
    previous,
    appliedFile,
  }: {
    stage: StageName;
    batch: Batch;
    previous: string;
    appliedFile: string;
  },
): Promise<BatchRun | undefined> => {
  const spec = stageSpecs[stage];
  const stored = storedBatchSchema.parse(JSON.parse(previous));

  if (spec.hostVerdict) {
    // The stored payload is delivered again as written, key order included.
    const copy: VerifiedCopy = { ...stored, draft: stored.draft };
    const validated = validateStage(
      scopeFor(ctx, stage, batch),
      stage,
      copy.draft,
    );

    if (validated.errors.length) {
      return undefined;
    }

    // Reuse names the stored output, so it never reads as a new response.
    await ctx.recorder?.record(
      'artifact_reused',
      { stage, batch: batch.index },
      { output: previous },
    );

    return {
      batch,
      ok: true,
      reused: true,
      attempts: 0,
      refusals: 0,
      usage: null,
      errors: [],
      copy,
      correctionsApplied: false,
    };
  }

  const validated = validateStage(scopeFor(ctx, stage, batch), stage, stored);

  if (validated.value === undefined || validated.errors.length) {
    return undefined;
  }

  const appliedSha = await readFile(appliedFile, 'utf8').catch(() => '');

  await ctx.recorder?.record(
    'artifact_reused',
    { stage, batch: batch.index },
    { output: previous },
  );

  return {
    batch,
    ok: true,
    reused: true,
    attempts: 0,
    refusals: 0,
    usage: null,
    errors: [],
    value: validated.value,
    correctionsApplied:
      'corrections' in stored && appliedSha === sha(stored.corrections),
  };
};

/** One batch: reused when its inputs are unchanged, otherwise sessions
 * until the host accepts an output, by the stage's own protocol. */
const runBatch = async (
  ctx: StageContext,
  {
    stage,
    batch,
    previousAccepted,
    force,
  }: {
    stage: StageName;
    batch: Batch;
    previousAccepted: boolean;
    force: boolean;
  },
): Promise<BatchRun> => {
  const spec = stageSpecs[stage];
  const label = `${stage}-${batch.index}`;

  if (spec.batched && !batch.files.length) {
    // Every file of the batch degraded upstream: nothing left to judge.
    return {
      batch,
      ok: true,
      reused: true,
      attempts: 0,
      refusals: 0,
      usage: null,
      errors: [],
      value: mergeBatches(stage, []),
    };
  }

  const outDir = path.join(ctx.dir, 'OUT', stage);
  const outFile = path.join(outDir, `${batch.index}.json`);
  const shaFile = path.join(outDir, `${batch.index}.inputs.sha`);
  const appliedFile = path.join(outDir, `${batch.index}.corrections.sha`);
  const refusedFile = path.join(outDir, `${batch.index}.refused.json`);
  const scope = scopeFor(ctx, stage, batch);
  const digest = await batchInputsDigest(ctx, stage, batch);
  const previous = await readFile(outFile, 'utf8').catch(() => null);
  const recorded = (await readFile(shaFile, 'utf8').catch(() => '')).trim();

  if (
    previous !== null &&
    recorded === digest &&
    (!force || previousAccepted)
  ) {
    const reused = await reusedBatch(ctx, {
      stage,
      batch,
      previous,
      appliedFile,
    });

    if (reused) {
      return reused;
    }
  }

  if (!spec.persistent) {
    await archiveNotes(ctx.dir, label);
  }

  const input = await spec.input(ctx, batch, true);

  if (input) {
    await writeFile(
      path.join(outDir, input.name),
      JSON.stringify(input.content, null, 2),
    );
  }

  if (spec.passes) {
    const previousPass = path.join(outDir, `${batch.index}.previous.json`);

    if (previous !== null) {
      await writeFile(previousPass, previous);
    } else {
      await rm(previousPass, { force: true });
    }
  }

  // A leftover output from an earlier run must never pass for this one's.
  for (const file of [outFile, shaFile, appliedFile, refusedFile]) {
    await rm(file, { force: true });
  }

  const files: BatchFiles = { label, digest, outFile, refusedFile };
  let run: Attempted;

  if (spec.hostVerdict) {
    if (!ctx.validateCopy) {
      throw new Error(`Copy draft has no editing verifier: ${label}.`);
    }

    run = await runVerifiedCopy(ctx, {
      stage,
      batch,
      files,
      validateCopy: ctx.validateCopy,
    });
  } else {
    run = await runCodexBatch(ctx, { stage, batch, files, scope });
  }

  const accepted = run.copy ?? run.value;

  if (accepted !== undefined) {
    await writeFile(outFile, JSON.stringify(accepted, null, 2));
    await writeFile(shaFile, digest);

    if (spec.hostVerdict) {
      await rm(path.join(ctx.dir, 'PENDING', `${label}.json`), { force: true });
    }

    await ctx.checkpoint?.([
      `OUT/${stage}/${batch.index}.json`,
      `OUT/${stage}/${batch.index}.inputs.sha`,
      `OUT/${stage}/${batch.index}.corrections.sha`,
      `JOURNAL/${label}.md`,
      `JOURNAL/${label}.failures.jsonl`,
      `JOURNAL/${label}.refusals.jsonl`,
      ...(spec.hostVerdict ? [`PENDING/${label}.json`] : []),
      ...(spec.research ? [`JOURNAL/${label}.research.jsonl`] : []),
    ]);
    printProgress(
      `${label} accepted${ctx.checkpoint ? '; checkpoint saved' : ''}`,
    );
  }

  return {
    batch,
    ok: accepted !== undefined,
    reused: false,
    attempts: run.attempts,
    refusals: run.refusals,
    usage: run.usage,
    errors: run.errors.map((error) => `batch ${batch.index}: ${error}`),
    value: run.value,
    copy: run.copy,
    ...(run.fatal !== undefined && { fatal: run.fatal }),
  };
};

const pool = async <T>(
  items: readonly T[],
  {
    concurrency,
    work,
  }: { concurrency: number; work: (item: T) => Promise<void> },
) => {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (let item = items[next]; item !== undefined; item = items[next]) {
        next += 1;
        await work(item);
      }
    },
  );

  await Promise.all(workers);
};

const acceptedReviewSchema = z.looseObject({
  verdict: z.unknown().optional(),
  corrections: z.array(z.unknown()).optional(),
});

/** An accepted batch with no new corrections needs no further review. */
const previouslyAccepted = async (
  ctx: StageContext,
  stage: StageName,
  batch: Batch,
): Promise<boolean> => {
  if (!stageSpecs[stage].passes) {
    return false;
  }

  const own = await readFile(
    path.join(ctx.dir, 'OUT', stage, `${batch.index}.json`),
    'utf8',
  ).catch(() => null);

  if (own === null) {
    return false;
  }

  const parsed = acceptedReviewSchema.safeParse(JSON.parse(own));

  return (
    parsed.success &&
    parsed.data.verdict === 'accepted' &&
    !parsed.data.corrections?.length
  );
};

type MergedStage = {
  value?: StageValue;
  copy?: VerifiedCopy;
  errors: string[];
};

/** The accepted batches as one stage output, checked as a whole unless the
 * host's verdict already decided each batch. */
const mergeAccepted = (
  ctx: StageContext,
  { stage, runs }: { stage: StageName; runs: readonly BatchRun[] },
): MergedStage => {
  if (stageSpecs[stage].hostVerdict) {
    // A host-verdict stage is one session: its batch is the output.
    return { copy: runs.find((run) => run.ok)?.copy, errors: [] };
  }

  const values = runs.flatMap((run) => {
    if (!run.ok || !run.value) {
      return [];
    }

    // Cached corrections already landed; replaying them could undo a
    // later review's correction to the same upstream field.
    return [
      run.reused && run.correctionsApplied && 'corrections' in run.value
        ? { ...run.value, corrections: [] }
        : run.value,
    ];
  });

  if (!values.length) {
    return { errors: [] };
  }

  const degraded = new Set(
    runs
      .filter((run) => !run.ok)
      .flatMap((run) => run.batch.files.map((file) => file.file)),
  );

  const covered = ctx.answers.filter((answer) => !degraded.has(answer.file));
  const checked = validateStage(
    { brand: ctx.brand, answers: covered, coverage: true },
    stage,
    mergeBatches(stage, values),
  );

  if (checked.value === undefined || checked.errors.length) {
    return { errors: checked.errors.map((error) => `merged: ${error}`) };
  }

  return { value: checked.value, errors: [] };
};

/** Review judged qualification against the state it just corrected. That
 * acceptance is preserved without blessing an already stale stage. */
const refreshQualifyDigests = async (ctx: StageContext) => {
  for (const batch of stageBatches(ctx, 'qualify')) {
    await writeFile(
      path.join(ctx.dir, 'OUT', 'qualify', `${batch.index}.inputs.sha`),
      await batchInputsDigest(ctx, 'qualify', batch),
    );
  }

  await writeFile(
    path.join(ctx.dir, 'OUT', 'qualify.inputs.sha'),
    await stageInputsDigest(ctx, 'qualify'),
  );
};

/** Digests are recorded after the stage's own corrections landed upstream:
 * the outputs are the judgment of that corrected state, so a resume reuses
 * them instead of rerunning every batch that corrected something (which
 * then corrects again, without end). */
const recordStageDigests = async (
  ctx: StageContext,
  { stage, runs }: { stage: StageName; runs: readonly BatchRun[] },
) => {
  for (const run of runs) {
    if (!run.ok) {
      continue;
    }

    const { batch } = run;

    await writeFile(
      path.join(ctx.dir, 'OUT', stage, `${batch.index}.inputs.sha`),
      await batchInputsDigest(ctx, stage, batch),
    );

    if (run.value && 'corrections' in run.value) {
      await writeFile(
        path.join(ctx.dir, 'OUT', stage, `${batch.index}.corrections.sha`),
        sha(run.value.corrections),
      );
    }
  }

  await writeFile(
    path.join(ctx.dir, 'OUT', `${stage}.inputs.sha`),
    await stageInputsDigest(ctx, stage),
  );
};

type StageSummaryInput = {
  batchCount: number;
  runs: readonly BatchRun[];
  degraded: readonly string[];
  value?: StageValue;
  copy?: VerifiedCopy;
  corrections: { applied: number; refused: number } | null;
};

const summarizeStage = ({
  batchCount,
  runs,
  degraded,
  value,
  copy,
  corrections,
}: StageSummaryInput): Record<string, unknown> => {
  const summary: Record<string, unknown> = {
    batches: batchCount,
    reused: runs.filter((run) => run.reused).length,
    attempts: runs.reduce((total, run) => total + run.attempts, 0),
    refusals: runs.reduce((total, run) => total + run.refusals, 0),
  };

  if (degraded.length) {
    summary.degraded = degraded.length;
  }

  if (value && 'rows' in value) {
    summary.rows = value.rows.length;
  }

  if (corrections) {
    summary.corrections = corrections.applied;

    if (corrections.refused) {
      summary.refusedCorrections = corrections.refused;
    }
  }

  if (copy) {
    summary.confidence = copy.confidence;
    summary.outcome = copy.outcome;
  }

  if (value && 'verdict' in value) {
    summary.verdict = value.verdict;
    summary.unresolved = value.unresolved.length;
    summary.failed = value.criteria
      .filter((criterion) => criterion.outcome === 'fail')
      .map((criterion) => criterion.criterionId);
  }

  return summary;
};

export const runStage = async (
  initial: StageContext,
  stage: StageName,
  options: { pass?: number; force?: boolean } = {},
): Promise<StageRun> => {
  const started = Date.now();
  const spec = stageSpecs[stage];

  await mkdir(path.join(initial.dir, 'OUT', stage), { recursive: true });
  await mkdir(path.join(initial.dir, 'JOURNAL'), { recursive: true });

  if (spec.research && !initial.research) {
    throw new Error(`The ${stage} stage needs its research tool server.`);
  }

  const ctx: StageContext = {
    ...initial,
    codexEnv: await prepareCodexHome(initial.dir, {
      stageModel: initial.stageModel,
      env: getEnvironment(),
      ...(spec.research && initial.research
        ? { research: initial.research }
        : {}),
    }),
  };

  const batches = stageBatches(ctx, stage);
  const qualificationWasFresh =
    stage === 'review' && (await isStageFresh(ctx, 'qualify'));
  const runsByIndex = new Map<number, BatchRun>();

  await pool(batches, {
    concurrency: ctx.concurrency ?? defaultConcurrency,
    work: async (batch) => {
      ctx.signal?.throwIfAborted();
      runsByIndex.set(
        batch.index,
        await runBatch(ctx, {
          stage,
          batch,
          previousAccepted: await previouslyAccepted(ctx, stage, batch),
          force: options.force ?? false,
        }),
      );
    },
  });

  // Every batch settled or the pool threw, so each index has its run.
  const runs = batches.flatMap((batch) => {
    const run = runsByIndex.get(batch.index);

    return run ? [run] : [];
  });

  const usage = sumUsage(runs.map((run) => run.usage));
  // A batch that never validated degrades the run instead of ending it
  // (Andrei, 2026-09-13: a solid first run over a perfect one): its
  // answers are left out of this stage and the ones after, and the
  // scorecard says so. With no accepted judgments, captures still survive.
  let degraded = runs
    .filter((run) => !run.ok)
    .flatMap((run) => run.batch.files.map((file) => file.file));
  const merged = mergeAccepted(ctx, { stage, runs });
  const errors = [...runs.flatMap((run) => run.errors), ...merged.errors];
  const fatal = runs.find((run) => run.fatal !== undefined)?.fatal;
  const { copy } = merged;
  let { value } = merged;

  if (!value && !copy && spec.deliversUnjudged) {
    // No model judgment is still a deliverable measurement. Preserve the
    // captured answers and describe the missing enrichment explicitly.
    value = mergeBatches(stage, []);
    degraded = ctx.answers.map((answer) => answer.file);
  }

  if (spec.passes && value && degraded.length && 'verdict' in value) {
    // A batch the reviewer never returned is a batch not yet accepted.
    value.verdict = 'needs_another_pass';
    value.unresolved.push({
      criterionId: 'host_batch_unvalidated',
      stage: 'host',
      file: null,
      problem: `The review of ${degraded.length} answer file(s) never validated: ${errors.slice(0, 3).join('; ').slice(0, 1500)}`,
      evidence: degraded.slice(0, 5).join(', ').slice(0, 600),
      whyNotFixed:
        'the host retried the batch and gave up; the next pass tries again',
    });
  }

  const output = value ?? copy;
  let corrections: { applied: number; refused: number } | null = null;

  if (output !== undefined) {
    await writeFile(
      path.join(ctx.dir, 'OUT', `${stage}.json`),
      JSON.stringify(output, null, 2),
    );

    if (spec.corrects && value && 'corrections' in value) {
      corrections = await applyCorrections(ctx, stage, value.corrections);
    }

    if (spec.passes && value && corrections?.refused && 'unresolved' in value) {
      value.verdict = 'needs_another_pass';
      value.unresolved.push({
        criterionId: 'host_correction_refused',
        stage: 'host',
        file: null,
        problem: `${corrections.refused} correction(s) did not pass the evidence checks.`,
        evidence: 'OUT/corrections.json',
        whyNotFixed:
          'Continue reviewing the current accepted state and correct the proposed changes.',
      });
      await writeFile(
        path.join(ctx.dir, 'OUT', `${stage}.json`),
        JSON.stringify(value, null, 2),
      );
    }

    if (qualificationWasFresh && corrections?.applied) {
      await refreshQualifyDigests(ctx);
    }

    await recordStageDigests(ctx, { stage, runs });

    if (spec.passes) {
      await mkdir(path.join(ctx.dir, 'REVIEW'), { recursive: true });
      await writeFile(
        path.join(ctx.dir, 'REVIEW', `${options.pass ?? 1}.json`),
        JSON.stringify(output, null, 2),
      );
    }
  }

  const result: StageRun = {
    stage,
    model: ctx.stageModel.model,
    ok: output !== undefined,
    durationMs: Date.now() - started,
    usage,
    errors,
    degraded,
    ...(fatal !== undefined && { fatal }),
    summary: summarizeStage({
      batchCount: batches.length,
      runs,
      degraded,
      value,
      copy,
      corrections,
    }),
  };

  await writeFile(
    path.join(ctx.dir, 'OUT', `${stage}.result.json`),
    JSON.stringify(result),
  );
  await ctx.checkpoint?.();

  return result;
};
