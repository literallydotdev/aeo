import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { canonicalJson } from '../lib/canonical-json';
import { serializeRunFile } from '../stores/run-lifecycle';

export const modelBudgetLimitsSchema = z
  .object({
    maxUsd: z.number().finite().positive(),
    maxTokens: z.number().int().positive(),
    deadlineAt: z.string().datetime(),
  })
  .strict();

export type ModelBudgetLimits = z.infer<typeof modelBudgetLimitsSchema>;

const callSchema = z
  .object({
    requestedModel: z.string().optional(),
    reasoningEffort: z.string().optional(),
    profileDigest: z.string().optional(),
    callId: z.string().min(1),
    role: z.string().min(1),
    reservedUsd: z.number().finite().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().nonnegative(),
    minRemainingUsd: z.number().finite().nonnegative().optional(),
    minRemainingTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ModelCallReservation = z.infer<typeof callSchema>;

export type ModelCallUsage = {
  requestedModel?: string;
  resolvedModel?: string;
  reasoningEffort?: string;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  requestId?: string;
  finishReason?: string;
  /**
   * False when the provider billed the call but produced no usable answer (a
   * refused gateway credit, an answer nothing parsed). Absent means the call
   * completed; a mandatory obligation is discharged only then.
   */
  valid?: boolean;
};

export type LedgerCall = ModelCallReservation & { usage?: ModelCallUsage };

/**
 * chargedCall returns what a call charges the ledger: its settled usage once
 * both token counts are known, otherwise its reservation. An indeterminate call
 * keeps its reservation until an attempt settles it.
 */
export const chargedCall = (
  call: LedgerCall,
): { usd: number; tokens: number } => {
  const { usage } = call;

  const charge = {
    usd: usage?.costUsd ?? call.reservedUsd,
    tokens:
      usage?.inputTokens !== undefined && usage.outputTokens !== undefined
        ? usage.inputTokens + usage.outputTokens
        : call.inputTokens + call.maxOutputTokens,
  };

  return charge;
};

export const chargedTotal = (
  calls: Iterable<LedgerCall>,
): {
  usd: number;
  tokens: number;
} => {
  let usd = 0;
  let tokens = 0;

  for (const call of calls) {
    const charge = chargedCall(call);

    usd += charge.usd;
    tokens += charge.tokens;
  }

  return { usd, tokens };
};

/** What a host model call sent and what came back, exactly as the
 * application supplied and received it (specs/aeo-open-source-cli-spec.md
 * §7.1). Never headers or credentials: those are not application input. */
export type ModelCallEvidence =
  | {
      kind: 'request';
      system: string | null;
      prompt: string;
      /** The output schema as JSON Schema; null when it has none. */
      schema: unknown;
      role: unknown;
      images: readonly { id: string; bytes: Uint8Array }[];
    }
  | {
      kind: 'response';
      payload: unknown;
      text: string | null;
      valid: boolean;
    };

export type ModelCallAccounting = {
  readonly deadlineAt?: string;
  reserve(call: ModelCallReservation): Promise<void>;
  assertOwned(): Promise<void>;
  settle(callId: string, usage: ModelCallUsage): Promise<void>;
  /**
   * Withdraws a reservation whose call was never dispatched (its operation
   * could not be recorded first). Unlike a settlement at $0, it records no
   * cost the provider did not report: the call leaves the ledger. A settled
   * call cannot be released.
   */
  release(callId: string): Promise<void>;
  /** Present when the run records its execution: the request before
   * dispatch, the response before settlement. A failure stops the call. */
  observe?(callId: string, evidence: ModelCallEvidence): Promise<void>;
};

export type ModelBudgetOwner =
  | { kind: 'agent'; jobId: string; batchJobId: string; attempt: number }
  | { kind: 'run'; runId: string; batchJobId?: string; attempt?: number }
  | {
      kind: 'workflow';
      pipelineId: string;
      runId: string;
      configVersion: number;
      copyVersion: number;
    }
  | { kind: 'operator'; runId: string; reportKey: string }
  | {
      kind: 'harness_copy';
      executionId: string;
      generation: number;
      batchJobId: string;
      attempt: number;
      runId: string;
    };

type BudgetState = {
  limits: ModelBudgetLimits;
  calls: Record<string, LedgerCall>;
};

type ModelBudgetErrorKind =
  'exhausted' | 'deadline' | 'integrity' | 'ownership';

export class ModelBudgetError extends Error {
  readonly kind: ModelBudgetErrorKind;

  constructor(message: string, kind: ModelBudgetErrorKind = 'integrity') {
    super(message);

    this.kind = kind;
    this.name = 'ModelBudgetError';
  }
}

const getErrorCode = (error: unknown): unknown => {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
};

const parseState = (raw: unknown, limits: ModelBudgetLimits): BudgetState => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelBudgetError('Persisted model budget must be a JSON object');
  }

  const state = z
    .object({
      limits: modelBudgetLimitsSchema,
      calls: z.record(
        z.string(),
        callSchema.extend({
          usage: z
            .object({
              requestedModel: z.string().optional(),
              resolvedModel: z.string().optional(),
              reasoningEffort: z.string().optional(),
              durationMs: z.number().finite().nonnegative().optional(),
              costUsd: z.number().finite().nonnegative().optional(),
              inputTokens: z.number().int().nonnegative().optional(),
              outputTokens: z.number().int().nonnegative().optional(),
              cachedInputTokens: z.number().int().nonnegative().optional(),
              reasoningTokens: z.number().int().nonnegative().optional(),
              requestId: z.string().optional(),
              finishReason: z.string().optional(),
              valid: z.boolean().optional(),
            })
            .strict()
            .optional(),
        }),
      ),
    })
    .strict();

  if (Object.keys(raw).length > 0) {
    const existing = state.parse(raw);

    // Dollars and tokens are the lineage's pins and cannot be replaced; the
    // elapsed deadline is the attempt's own, so the persisted ledger adopts
    // the attempt's deadline and keeps every call it holds (2026-09-13).
    if (
      limits.maxUsd < existing.limits.maxUsd ||
      limits.maxTokens < existing.limits.maxTokens
    ) {
      throw new ModelBudgetError(
        'The persisted model budget cannot be replaced',
      );
    }

    return { ...existing, limits: { ...limits } };
  }

  return { limits: modelBudgetLimitsSchema.parse(limits), calls: {} };
};

/**
 * validateModelBudgetState lets retry admission preserve the ledger only after
 * validating its original pins.
 */
export const validateModelBudgetState = (
  raw: unknown,
  limits: ModelBudgetLimits,
): void => {
  parseState(raw, limits);
};

type ReserveCallOptions = {
  now: number;
};

const reserveCall = (
  state: BudgetState,
  input: ModelCallReservation,
  { now }: ReserveCallOptions,
): BudgetState => {
  const call = callSchema.parse(input);

  if (Date.parse(state.limits.deadlineAt) <= now) {
    throw new ModelBudgetError('Model budget deadline reached', 'deadline');
  }

  // A resumed request must never redispatch an indeterminate call under its old ID.
  if (Object.hasOwn(state.calls, call.callId)) {
    throw new ModelBudgetError('Model call ID already reserved');
  }

  const totals = chargedTotal(Object.values(state.calls));

  if (
    totals.usd + call.reservedUsd + (call.minRemainingUsd ?? 0) >
      state.limits.maxUsd ||
    totals.tokens +
      call.inputTokens +
      call.maxOutputTokens +
      (call.minRemainingTokens ?? 0) >
      state.limits.maxTokens
  ) {
    throw new ModelBudgetError(
      'Insufficient remaining model budget',
      'exhausted',
    );
  }

  const reserved = { ...state, calls: { ...state.calls, [call.callId]: call } };

  return reserved;
};

type SettleCallOptions = {
  callId: string;
  usage: ModelCallUsage;
};

const settleCall = (
  state: BudgetState,
  { callId, usage }: SettleCallOptions,
): BudgetState => {
  const call = state.calls[callId];

  if (!call) {
    throw new ModelBudgetError('Model call was not reserved');
  }

  if (call.usage) {
    if (canonicalJson(call.usage) !== canonicalJson(usage)) {
      throw new ModelBudgetError('Model usage is immutable');
    }

    return state;
  }

  // Validate provider metadata before it can release any reservation.
  const next = parseState(
    { ...state, calls: { ...state.calls, [callId]: { ...call, usage } } },
    state.limits,
  );

  const settled = { ...state, calls: next.calls };

  return settled;
};

const releaseCall = (state: BudgetState, callId: string): BudgetState => {
  const call = state.calls[callId];

  if (!call) {
    throw new ModelBudgetError('Model call was not reserved');
  }

  if (call.usage) {
    throw new ModelBudgetError('A settled model call cannot be released');
  }

  const { [callId]: _released, ...calls } = state.calls;

  return { ...state, calls };
};

// Runs synchronous work so that a throw becomes a rejected promise, as it would
// inside an async function.
const runAsPromise = (work: () => void) => {
  return new Promise<void>((resolve) => {
    work();
    resolve();
  });
};

export const createMemoryModelAccounting = (
  limits: ModelBudgetLimits,
  now = () => Date.now(),
): ModelCallAccounting & { state: BudgetState } => {
  const state = parseState({}, limits);

  // The ledger object stays the same instance because callers read `state`.
  const accounting = {
    state,
    deadlineAt: state.limits.deadlineAt,
    assertOwned: () => Promise.resolve(),
    reserve: (call: ModelCallReservation) => {
      return runAsPromise(() => {
        state.calls = reserveCall(state, call, { now: now() }).calls;
      });
    },
    settle: (callId: string, usage: ModelCallUsage) => {
      return runAsPromise(() => {
        state.calls = settleCall(state, { callId, usage }).calls;
      });
    },
    release: (callId: string) => {
      return runAsPromise(() => {
        state.calls = releaseCall(state, callId).calls;
      });
    },
  };

  return accounting;
};

export const createFileModelAccounting = (args: {
  filename: string;
  limits: ModelBudgetLimits;
  assertOwned: () => Promise<void>;
}): ModelCallAccounting => {
  const limits = modelBudgetLimitsSchema.parse(args.limits);

  const acquireLock = async (lockPath: string) => {
    let lock: FileHandle | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        lock = await open(lockPath, 'wx', 0o600);

        break;
      } catch (error) {
        if (getErrorCode(error) !== 'EEXIST') {
          throw error;
        }

        const pid = Number(await readFile(lockPath, 'utf8').catch(() => ''));

        if (!Number.isSafeInteger(pid) || pid <= 0) {
          throw new ModelBudgetError('Model budget writer lock is held');
        }

        try {
          process.kill(pid, 0);
          throw new ModelBudgetError('Model budget writer lock is held');
        } catch (probe) {
          if (getErrorCode(probe) !== 'ESRCH') {
            throw probe;
          }

          await unlink(lockPath);
        }
      }
    }

    if (!lock) {
      throw new ModelBudgetError('Model budget writer unavailable');
    }

    return lock;
  };

  const readRawState = async (): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(args.filename, 'utf8'));
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }

      return {};
    }
  };

  const update = async (
    change: (state: BudgetState) => BudgetState,
  ): Promise<void> => {
    await serializeRunFile(args.filename, async () => {
      await mkdir(dirname(args.filename), { recursive: true, mode: 0o700 });

      const lockPath = `${args.filename}.lock`;
      const lock = await acquireLock(lockPath);
      const temporary = `${args.filename}.${randomUUID()}.tmp`;

      try {
        await lock.writeFile(String(process.pid));
        await lock.sync();
        await args.assertOwned();

        const state = change(parseState(await readRawState(), limits));
        const output = await open(temporary, 'wx', 0o600);

        try {
          await output.writeFile(JSON.stringify(state));
          await output.sync();
        } finally {
          await output.close();
        }

        await args.assertOwned();
        await rename(temporary, args.filename);

        const directory = await open(dirname(args.filename), 'r');

        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await unlink(temporary).catch(() => {});
        await lock.close();
        await unlink(lockPath);
      }
    });
  };

  const accounting: ModelCallAccounting = {
    deadlineAt: limits.deadlineAt,
    assertOwned: args.assertOwned,
    reserve: async (call) => {
      await update((state) => reserveCall(state, call, { now: Date.now() }));
    },
    settle: async (callId, usage) => {
      await update((state) => settleCall(state, { callId, usage }));
    },
    release: async (callId) => {
      await update((state) => releaseCall(state, callId));
    },
  };

  return accounting;
};

/**
 * createPostgresModelAccounting charges the pipeline budget for every job; a
 * standalone run owns its own budget.
 */
export const createPostgresModelAccounting = (args: {
  sql: Sql;
  owner: ModelBudgetOwner;
  pipelineId?: string;
  runId?: string;
  limits: ModelBudgetLimits;
}): ModelCallAccounting => {
  const limits = modelBudgetLimitsSchema.parse(args.limits);
  const rowId = args.pipelineId ?? args.runId;

  if (!rowId) {
    throw new ModelBudgetError('Model budget owner is missing');
  }

  const table = args.pipelineId ? 'AeoPipeline' : 'AeoRun';
  const key = args.pipelineId ? 'pipelineId' : 'runId';
  const owned = async (tx: TransactionSql): Promise<unknown> => {
    const [row] = await tx.unsafe<
      {
        modelBudget: unknown;
        status: string;
        reportKey: string;
        runId?: string;
        configVersion?: number;
        copyVersion?: number;
        request: { modelBudget?: unknown } | null;
        stage?: string;
      }[]
    >(`SELECT * FROM "${table}" WHERE "${key}" = $1 FOR UPDATE`, [rowId]);

    if (!row) {
      throw new ModelBudgetError('Model budget owner does not exist');
    }

    const pinned = modelBudgetLimitsSchema.safeParse(row.request?.modelBudget);
    // Dollars and tokens are pinned on the owner for the lineage; the
    // elapsed deadline is the attempt's own (2026-09-13).
    if (
      !pinned.success ||
      pinned.data.maxUsd < limits.maxUsd ||
      pinned.data.maxTokens < limits.maxTokens
    ) {
      throw new ModelBudgetError(
        'Model budget does not match the admitted request',
      );
    }

    const owner = args.owner;

    if (args.pipelineId && !['running', 'waiting'].includes(row.status)) {
      throw new ModelBudgetError('Pipeline no longer owns model work');
    }

    if (owner.kind === 'agent') {
      const [job] = await tx<
        {
          pipelineId: string;
          status: string;
          batchJobId: string;
          batchAttempt: number;
          kind: string;
        }[]
      >`
        SELECT "pipelineId", status, "batchJobId", "batchAttempt", kind FROM "AeoAgentJob" WHERE "jobId" = ${owner.jobId} FOR UPDATE`;

      if (
        !job ||
        job.pipelineId !== args.pipelineId ||
        job.status !== 'running' ||
        row.status !== 'running' ||
        row.stage !== (job.kind === 'author' ? 'author' : 'copy') ||
        job.batchJobId !== owner.batchJobId ||
        job.batchAttempt !== owner.attempt
      ) {
        throw new ModelBudgetError('Agent no longer owns model work');
      }
    } else if (owner.kind === 'run') {
      const [run] = await tx<
        {
          pipelineId: string | null;
          status: string;
          batchJobId: string | null;
          batchAttempt: number | null;
        }[]
      >`
        SELECT "pipelineId", status, "batchJobId", "batchAttempt" FROM "AeoRun" WHERE "runId" = ${owner.runId} FOR UPDATE`;

      if (
        !run ||
        (!args.pipelineId && owner.runId !== rowId) ||
        run.status !== 'running' ||
        (run.pipelineId ?? undefined) !== args.pipelineId ||
        (run.batchJobId ?? undefined) !== owner.batchJobId ||
        (run.batchAttempt ?? undefined) !== owner.attempt ||
        (args.pipelineId && row.stage !== 'run')
      ) {
        throw new ModelBudgetError('Run no longer owns model work');
      }
    } else if (owner.kind === 'harness_copy') {
      const [execution] = await tx<
        {
          pipelineId: string | null;
          generation: number;
          ownerBatchJobId: string | null;
          ownerAttempt: number | null;
          state: { kind: string; stage?: string };
          cancelRequestedAt: Date | null;
        }[]
      >`
        SELECT "pipelineId", generation, "ownerBatchJobId", "ownerAttempt", state, "cancelRequestedAt"
        FROM "AeoHarnessExecution" WHERE "executionId"=${owner.executionId} FOR UPDATE`;

      if (
        execution?.generation !== owner.generation ||
        execution.ownerBatchJobId !== owner.batchJobId ||
        execution.ownerAttempt !== owner.attempt ||
        execution.cancelRequestedAt ||
        execution.state.kind !== 'running' ||
        execution.state.stage !== 'copy' ||
        (execution.pipelineId ?? undefined) !== args.pipelineId ||
        (args.pipelineId &&
          (row.runId !== owner.runId || row.stage !== 'copy')) ||
        (!args.pipelineId && rowId !== owner.runId)
      ) {
        throw new ModelBudgetError(
          'Copy worker no longer owns model work',
          'ownership',
        );
      }
    } else if (owner.kind === 'workflow') {
      if (
        args.pipelineId !== owner.pipelineId ||
        row.runId !== owner.runId ||
        row.configVersion !== owner.configVersion ||
        row.copyVersion !== owner.copyVersion
      ) {
        throw new ModelBudgetError('Workflow target changed before model work');
      }
    } else if (
      args.pipelineId ||
      owner.runId !== rowId ||
      owner.reportKey !== row.reportKey ||
      !['running', 'completed'].includes(row.status)
    ) {
      throw new ModelBudgetError('Operator model target is invalid');
    }

    return row.modelBudget;
  };

  const update = async (
    change: (state: BudgetState) => BudgetState,
  ): Promise<void> => {
    await args.sql.begin(async (tx) => {
      const state = change(parseState(await owned(tx), limits));
      const encoded = tx.json(state);

      if (args.pipelineId) {
        await tx`UPDATE "AeoPipeline" SET "modelBudget" = ${encoded} WHERE "pipelineId" = ${rowId}`;
      } else {
        await tx`UPDATE "AeoRun" SET "modelBudget" = ${encoded} WHERE "runId" = ${rowId}`;
      }
    });
  };

  const accounting: ModelCallAccounting = {
    deadlineAt: limits.deadlineAt,
    assertOwned: async () => {
      await args.sql.begin(async (tx) => {
        await owned(tx);
      });
    },
    reserve: async (call) => {
      await update((state) => reserveCall(state, call, { now: Date.now() }));
    },
    settle: async (callId, usage) => {
      await update((state) => settleCall(state, { callId, usage }));
    },
    release: async (callId) => {
      await update((state) => releaseCall(state, callId));
    },
  };

  return accounting;
};
