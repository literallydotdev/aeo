import { readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { mintRunId } from '../lib/run-id';
import type {
  ModelCallAccounting,
  ModelCallEvidence,
  ModelCallReservation,
  ModelCallUsage,
} from '../models/accounting';
import type { ProbeAttemptEnd, ProbeTrace } from '../probes/probe-trace';
import { hasErrorCode } from '../stores/fs-errors';
import {
  operationKinds,
  toolId,
  toolVersion,
  type EventType,
  type OperationKind,
  type RunOrigin,
} from './contracts';
import { openJournal, putObject, readJournal, type Journal } from './journal';
import { observedIsolation, type WriterIsolation } from './isolation';

// ============================================================================
// The execution recorder (specs/aeo-open-source-cli-spec.md §7): the host
// writes what it observes as it happens, into the run journal under
// JOURNAL/run/ (checkpointed with the rest of JOURNAL/). Inputs and outputs
// are content-addressed objects written before the event that names them.
// Nothing here asks a model to describe the run.
// ============================================================================

export const runJournalDir = path.join('JOURNAL', 'run');

/** Every kind of host-visible operation the recorder can observe. */
export const recordedOperationKinds = operationKinds;

export type { OperationKind };

/** What a workflow-only writer observes: the hosted job captures and checks
 * before its work directory exists, so it records only the workflow. */
export const workflowOperationKinds: readonly OperationKind[] = [
  'codex_session',
  'host_model_call',
];

type Content = string | Buffer;

export type OperationStart = {
  kind: OperationKind;
  stage?: string;
  role?: string;
  batch?: number;
  attempt?: number;
  parentOperationId?: string;
  /** Exact application inputs, stored as objects by name. */
  inputs?: Record<string, Content | undefined>;
  details?: Record<string, unknown>;
};

export type OperationOutcome =
  'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';

export type OperationFinish = {
  outcome: OperationOutcome;
  outputs?: Record<string, Content | undefined>;
  details?: Record<string, unknown>;
};

export type OperationHandle = {
  id: string;
  finish: (result: OperationFinish) => Promise<void>;
};

export type ExecutionRecorder = {
  start: (operation: OperationStart) => Promise<OperationHandle>;
  /** A host decision about work: an output accepted, refused or reused. */
  record: (
    type: Extract<
      EventType,
      | 'output_accepted'
      | 'output_refused'
      | 'artifact_reused'
      | 'correction_applied'
      | 'correction_refused'
      | 'run_completed'
      | 'run_failed'
      | 'run_interrupted'
      | 'budget_amended'
    >,
    payload: Record<string, unknown>,
    objects?: Record<string, Content | undefined>,
  ) => Promise<void>;
};

const storeObjects = async (
  root: string,
  contents: Record<string, Content | undefined> = {},
): Promise<{ names: Record<string, string>; digests: string[] }> => {
  const names: Record<string, string> = {};

  for (const [name, content] of Object.entries(contents)) {
    if (content !== undefined) {
      names[name] = await putObject(root, content);
    }
  }

  return { names, digests: [...new Set(Object.values(names))] };
};

const createRecorder = (root: string, journal: Journal): ExecutionRecorder => {
  const start = async (operation: OperationStart): Promise<OperationHandle> => {
    const id = mintRunId();
    const { inputs, details, ...identity } = operation;
    const stored = await storeObjects(root, inputs);

    await journal.append({
      type: 'operation_started',
      operationId: id,
      payload: {
        ...identity,
        inputs: stored.names,
        ...(details && { details }),
      },
      objects: stored.digests,
    });

    const finish = async (result: OperationFinish) => {
      const outputs = await storeObjects(root, result.outputs);

      await journal.append({
        type: 'operation_finished',
        operationId: id,
        payload: {
          outcome: result.outcome,
          outputs: outputs.names,
          ...(result.details && { details: result.details }),
        },
        objects: outputs.digests,
      });
    };

    return { id, finish };
  };

  const record: ExecutionRecorder['record'] = async (
    type,
    payload,
    objects,
  ) => {
    const stored = await storeObjects(root, objects);

    await journal.append({
      type,
      payload: { ...payload, objects: stored.names },
      objects: stored.digests,
    });
  };

  return { start, record };
};

export type OpenRecorderOptions = {
  origin: RunOrigin;
  runId: string;
  /** The frozen measurement and plan digests the journal belongs to. */
  measurementDigest: string;
  planDigest: string;
  /** The abandoned writer this process took the directory over from. */
  takenOver?: { host: string; pid: number; acquiredAt: string };
  /** The operation kinds this writer records, declared in run_started and
   * run_resumed (spec §7.2): the export claims coverage only for kinds
   * every writer observed. Defaults to the workflow's own. */
  observes?: readonly OperationKind[];
  /** The boundary this writer runs inside; observed from the process when
   * the writer does not state it. */
  isolation?: WriterIsolation;
};

const frozenMeasurement = (text: string): string | undefined => {
  const plan = readJournal(text).events.find(
    (event) => event.type === 'plan_frozen',
  );
  const digest = plan?.payload.measurementDigest;

  return typeof digest === 'string' ? digest : undefined;
};

/**
 * openRecorder opens the run journal of a work directory. A new journal
 * starts with run_started and plan_frozen; an existing one for the same
 * measurement records run_resumed. A journal frozen for another measurement
 * (the directory was prepared again under a changed config) is set aside
 * whole, since one journal never describes two measurements.
 */
export const openRecorder = async (
  dir: string,
  options: OpenRecorderOptions,
): Promise<ExecutionRecorder> => {
  const root = path.join(dir, runJournalDir);
  const eventsFile = path.join(root, 'events.jsonl');
  const existing = await readFile(eventsFile, 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });

  if (
    existing !== undefined &&
    frozenMeasurement(existing) !== options.measurementDigest
  ) {
    const created = await stat(eventsFile);

    await rename(
      root,
      `${root}-superseded-${created.mtime.toISOString().replace(/[:.]/g, '-')}`,
    );
  }

  const journal = await openJournal(root);
  const runtime = {
    tool: toolId,
    version: toolVersion,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    isolation: options.isolation ?? observedIsolation(),
  };

  const observes = [...(options.observes ?? workflowOperationKinds)];

  if (journal.head().count === 0) {
    await journal.append({
      type: 'run_started',
      payload: {
        runId: options.runId,
        origin: options.origin,
        runtime,
        observes,
      },
    });
    await journal.append({
      type: 'plan_frozen',
      payload: {
        measurementDigest: options.measurementDigest,
        planDigest: options.planDigest,
      },
    });
  } else {
    await journal.append({
      type: 'run_resumed',
      payload: { origin: options.origin, runtime, observes },
    });
  }

  if (options.takenOver) {
    await journal.append({
      type: 'writer_takeover',
      payload: { previous: options.takenOver },
    });
  }

  return createRecorder(root, journal);
};

type CallEvidence = Extract<ModelCallEvidence, { kind: 'request' }>;
type ResponseEvidence = Extract<ModelCallEvidence, { kind: 'response' }>;

const requestObjects = (request: CallEvidence | undefined) => {
  if (!request) {
    return undefined;
  }

  const images = Object.fromEntries(
    request.images.map((image, index) => [
      `image-${index}-${image.id}`,
      Buffer.from(image.bytes),
    ]),
  );
  const objects = {
    system: request.system ?? undefined,
    prompt: request.prompt,
    schema:
      request.schema === null ? undefined : JSON.stringify(request.schema),
    role: JSON.stringify(request.role),
    ...images,
  };

  return objects;
};

const responseObjects = (response: ResponseEvidence | undefined) => {
  if (!response) {
    return undefined;
  }

  const objects = {
    payload:
      response.payload === null ? undefined : JSON.stringify(response.payload),
    text: response.text ?? undefined,
  };

  return objects;
};

/**
 * recordingAccounting wraps host model accounting so every host call is an
 * operation: opened when its budget is reserved, before dispatch, with the
 * exact request generateStructured observed as its inputs, and finished
 * when it settles, with the response and the model the provider reported.
 * A call that never settles stays open, an unknown outcome, never a success.
 */
export const recordingAccounting = (
  accounting: ModelCallAccounting,
  recorder: ExecutionRecorder,
): ModelCallAccounting => {
  const open = new Map<string, OperationHandle>();
  const requests = new Map<string, CallEvidence>();
  const responses = new Map<string, ResponseEvidence>();

  const observe = async (callId: string, evidence: ModelCallEvidence) => {
    await accounting.observe?.(callId, evidence);

    if (evidence.kind === 'request') {
      requests.set(callId, evidence);
    } else {
      responses.set(callId, evidence);
    }
  };

  const reserve = async (call: ModelCallReservation) => {
    await accounting.reserve(call);

    const request = requests.get(call.callId);

    requests.delete(call.callId);

    const handle = await recorder.start({
      kind: 'host_model_call',
      role: call.role,
      inputs: requestObjects(request),
      details: {
        callId: call.callId,
        requestedModel: call.requestedModel ?? null,
        reasoningEffort: call.reasoningEffort ?? null,
        profileDigest: call.profileDigest ?? null,
        reservedUsd: call.reservedUsd,
        reservedInputTokens: call.inputTokens,
        maxOutputTokens: call.maxOutputTokens,
        // A caller outside generateStructured reserves without describing
        // its request; the gap is stated, not hidden.
        requestRecorded: request !== undefined,
      },
    });

    open.set(call.callId, handle);
  };

  const settle = async (callId: string, usage: ModelCallUsage) => {
    await accounting.settle(callId, usage);

    const handle = open.get(callId);
    const response = responses.get(callId);

    open.delete(callId);
    responses.delete(callId);
    await handle?.finish({
      outcome: usage.valid === false ? 'failed' : 'succeeded',
      outputs: responseObjects(response),
      details: {
        // Reported by the provider; null when it did not say, never filled
        // in from the requested model.
        resolvedModel: usage.resolvedModel ?? null,
        requestId: usage.requestId ?? null,
        finishReason: usage.finishReason ?? null,
        durationMs: usage.durationMs ?? null,
        costUsd: usage.costUsd ?? null,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        reasoningTokens: usage.reasoningTokens ?? null,
        responseRecorded: response !== undefined,
      },
    });
  };

  const wrapped: ModelCallAccounting = {
    deadlineAt: accounting.deadlineAt,
    reserve,
    settle,
    observe,
    assertOwned: () => accounting.assertOwned(),
  };

  return wrapped;
};

const errorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/**
 * recorded runs one operation under the journal: started before `run`
 * dispatches, finished with what `finish` makes of its value, or failed
 * (cancelled when `signal` was aborted) with the error, which is rethrown.
 * Without a recorder it only runs.
 */
export const recorded = async <T>({
  recorder,
  start,
  run,
  finish,
  signal,
}: {
  recorder: ExecutionRecorder | undefined;
  start: OperationStart;
  run: () => Promise<T>;
  finish: (value: T) => OperationFinish;
  signal?: AbortSignal;
}): Promise<T> => {
  if (!recorder) {
    return run();
  }

  const handle = await recorder.start(start);
  let value: T;

  try {
    value = await run();
  } catch (error) {
    await handle.finish({
      outcome: signal?.aborted ? 'cancelled' : 'failed',
      details: { error: errorText(error).slice(0, 2000) },
    });

    throw error;
  }

  await handle.finish(finish(value));

  return value;
};

/**
 * probeTraceOf records probe attempts (or canaries) as operations: the
 * prompt as input; the answer and its retrieval log as outputs; the
 * requested and reported model, or the failure, as details.
 */
export const probeTraceOf = (
  recorder: ExecutionRecorder,
  kind: Extract<OperationKind, 'probe' | 'canary'>,
): ProbeTrace => {
  const start: ProbeTrace['start'] = async (attempt) => {
    const handle = await recorder.start({
      kind,
      role: attempt.surface,
      attempt: attempt.attempt,
      inputs: { prompt: attempt.promptText },
      details: {
        sectionKey: attempt.sectionKey ?? null,
        surface: attempt.surface,
        promptId: attempt.promptId,
        runIndex: attempt.runIndex,
        retryOf: attempt.retryOf ?? null,
        requestedModel: attempt.requestedModel,
      },
    });

    const end = async (result: ProbeAttemptEnd) => {
      if (result.outcome !== 'succeeded') {
        await handle.finish({
          outcome: result.outcome,
          details: { kind: result.kind, error: result.error.slice(0, 2000) },
        });

        return;
      }

      await handle.finish({
        outcome: 'succeeded',
        outputs: {
          answer: result.text,
          retrieval:
            result.retrieval === null
              ? undefined
              : JSON.stringify(result.retrieval),
        },
        details: {
          requestedModel: result.requestedModel,
          // Reported by the provider or the CLI's own events; null when
          // neither named one, never the requested model (§7.1).
          reportedModel: result.reportedModel ?? null,
          noOverview: result.noOverview === true,
        },
      });
    };

    return { id: handle.id, end };
  };

  return { start };
};
