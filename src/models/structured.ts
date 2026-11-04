import { randomUUID } from 'node:crypto';
import { createGateway, GatewayInternalServerError } from '@ai-sdk/gateway';
import { Agent, fetch as undiciFetch } from 'undici';
import { NoObjectGeneratedError, Output, streamText } from 'ai';
import { z } from 'zod';
import { createLog } from '../lib/log';
import { readEnv } from '../lib/env';
import {
  structuredWireSchema,
  type StructuredSchemaIssue,
} from './wire-schema';
import { structuredFailureDiagnostic } from './failure-diagnostics';
import { ModelBudgetError, type ModelCallAccounting } from './accounting';
import { assertModelCallActive } from './errors';
import {
  structuredImageMessages,
  structuredImageTokens,
  type StructuredImage,
} from './structured-images';
import {
  internalModelRoleSchema,
  internalModelRoleDigest,
  type InternalModelRoleConfig,
} from './profiles';
import { servedModelOf } from './served-model';

export type StructuredCallUsage = {
  callId: string;
  requestedModel: string;
  resolvedModel?: string;
  reasoningEffort?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  requestId?: string;
  finishReason?: string;
  /** False when the provider billed the call without a usable answer. */
  valid?: boolean;
};
/** The bounded provider response, retained durably before application
 * parsing or settlement (orchestrator spec §4.4). A parse failure or a lost
 * process after this point replays from the observation, never regenerates. */
export type StructuredCallObservation = {
  callId: string;
  /** The provider's structured payload when it produced one. */
  payload: unknown;
  /** The raw response text when the transport exposes it. */
  text: string | null;
  valid: boolean;
  usage: StructuredCallUsage;
};
export type StructuredCallJournal = {
  observe(observation: StructuredCallObservation): Promise<void>;
};
type ReportedUsage = Omit<
  StructuredCallUsage,
  'callId' | 'requestedModel' | 'reasoningEffort' | 'durationMs'
>;

type StructuredOutputMiss = {
  text: string | null;
  usage: ReportedUsage;
  /** Why it was refused, so a caller can ask for a repair. */
  issues: readonly StructuredSchemaIssue[];
};

/**
 * StructuredOutputMissingError means the provider answered and billed, but
 * produced no value matching the response schema. The retained text and
 * reported usage travel with the error so the attempt is journaled and settled
 * instead of being lost.
 */
export class StructuredOutputMissingError extends Error {
  readonly text: string | null;
  readonly usage: ReportedUsage;
  readonly issues: readonly StructuredSchemaIssue[];

  constructor(
    { text, usage, issues }: StructuredOutputMiss,
    { cause }: { cause: unknown },
  ) {
    super('Model produced no value matching the response schema', { cause });

    this.text = text;
    this.usage = usage;
    this.issues = issues;
    this.name = 'StructuredOutputMissingError';
  }
}

/**
 * StructuredJournalError means a response was received but could not be
 * journaled. The retained bytes travel with the error so the caller retries
 * persistence, not generation.
 */
export class StructuredJournalError extends Error {
  readonly observation: StructuredCallObservation;

  constructor(observation: StructuredCallObservation, cause: unknown) {
    super('Model response could not be journaled', { cause });

    this.observation = observation;
    this.name = 'StructuredJournalError';
  }
}

export type StructuredCallInput<T> = {
  roleName: string;
  role: InternalModelRoleConfig;
  schema: z.ZodType<T>;
  prompt: string;
  images?: readonly StructuredImage[];
  system?: string;
  signal?: AbortSignal;
  accounting: ModelCallAccounting;
  /** Host-issued durable call ID; legacy callers get a fresh UUID. */
  callId?: string;
  journal?: StructuredCallJournal;
};

/** Injection is a single no-tools network step, never an opaque agent loop. */
export type StructuredTransport = {
  <T>(
    input: Omit<StructuredCallInput<T>, 'accounting' | 'journal'> & {
      signal: AbortSignal;
    },
  ): Promise<{
    output: T;
    text?: string;
    usage: ReportedUsage;
  }>;
};

/** The reasoning effort a role asks for, however its provider takes it. */
const reasoningEffortOf = (
  role: InternalModelRoleConfig,
): string | undefined => {
  const { openai, gateway } = role.providerOptions;
  const gatewayEffort =
    gateway && 'effort' in gateway.reasoning
      ? gateway.reasoning.effort
      : undefined;

  return openai?.reasoningEffort ?? gatewayEffort;
};

const reportedNumber = (value: unknown): number | undefined => {
  const number =
    typeof value === 'string' && value.trim() ? Number(value) : value;

  return typeof number === 'number' && Number.isFinite(number) && number >= 0
    ? number
    : undefined;
};

const isGatewayCreditRefusal = (error: unknown): boolean => {
  // Gateway requires a positive balance before routing even BYOK requests:
  // https://vercel.com/docs/ai-gateway/authentication-and-byok/byok
  // Only its explicit credit precheck proves zero usage. Other 402 responses,
  // provider errors and timeouts can have unknown spend and stay reserved.
  return (
    GatewayInternalServerError.isInstance(error) &&
    error.statusCode === 402 &&
    error.message.startsWith(
      'A positive credit balance is required for all requests, including BYOK, so fallback providers remain available. Add credits at https://vercel.com/',
    )
  );
};

// Two ceilings sit above every model call, and neither is the role deadline.
// Node's HTTP client abandons a request after five minutes by default, and
// the gateway abandons a NON-STREAMING request at 340 seconds (measured five
// times on 2026-09-11, always within 16ms, across three roles; a streaming
// request runs several times longer). So the transport streams, and its own
// client timeout is set above the largest role deadline. Every call already
// carries an AbortSignal built from that deadline and the remaining budget,
// so the transport never becomes the thing that decides when to give up.
const transportTimeoutMs = 960_000;

const dispatcher = new Agent({
  headersTimeout: transportTimeoutMs,
  bodyTimeout: transportTimeoutMs,
});

// Undici's fetch accepts the dispatcher; the global one does not expose it.
const fetchWithDispatcher = (
  request: string | URL,
  init?: Parameters<typeof undiciFetch>[1],
) => {
  return undiciFetch(request, { ...init, dispatcher });
};

const gateway = createGateway({
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Undici's fetch types differ from the DOM fetch type the SDK declares, though both are compatible at runtime.
  fetch: fetchWithDispatcher as unknown as typeof globalThis.fetch,
});

/**
 * dispatchProviderOptions returns the provider options a call dispatches with.
 * A pinned profile names the gateway routes a family may use (`gateway.only`);
 * `AEO_GATEWAY_ROUTE_DENYLIST` (comma-separated route names) removes routes from
 * that list at call time without touching the pin, because route health is
 * operational, not part of what was admitted: a route can pass a one-object
 * probe and then refuse a real request with no output, on an execution whose
 * pin already names it. A
 * denylist that would empty the allowlist is ignored rather than dispatching
 * with none.
 */
export const dispatchProviderOptions = (
  providerOptions: InternalModelRoleConfig['providerOptions'],
  denylist = readEnv('AEO_GATEWAY_ROUTE_DENYLIST') ?? '',
): InternalModelRoleConfig['providerOptions'] => {
  const denied = denylist
    .split(',')
    .map((route) => route.trim())
    .filter(Boolean);
  const gatewayOptions = providerOptions.gateway;
  const only = gatewayOptions?.only;

  if (denied.length === 0 || !gatewayOptions || !only) {
    return providerOptions;
  }

  const allowed = only.filter((route) => !denied.includes(route));

  if (allowed.length === 0 || allowed.length === only.length) {
    return providerOptions;
  }

  return { ...providerOptions, gateway: { ...gatewayOptions, only: allowed } };
};

const gatewayTransport: StructuredTransport = async (input) => {
  const wire = structuredWireSchema(input.schema);
  // A streamed request reports a provider failure as an error part, not a
  // thrown error: without an `onError` the SDK's default prints it with
  // `console.error`, which serialises an APICallError's own properties —
  // including `requestBodyValues`, the entire prompt. It then synthesises a
  // causeless NoOutputGeneratedError, so the caller cannot tell a 402 from a
  // schema miss. Capturing it keeps the prompt out of stderr and restores
  // the error identity every classifier downstream is written against.
  let streamFailure: unknown;
  const result = streamText({
    onError: ({ error }) => {
      streamFailure ??= error;
    },
    model: gateway(input.role.model),
    output: Output.object({ schema: wire.sdkSchema }),
    providerOptions: dispatchProviderOptions(input.role.providerOptions),
    maxOutputTokens: input.role.maxOutputTokens,
    maxRetries: 0,
    abortSignal: input.signal,
    system: [
      input.system,
      wire.wrapped
        ? 'Return the requested result inside the top-level result property required by the response schema.'
        : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
    ...(input.images?.length
      ? { messages: structuredImageMessages(input.prompt, input.images) }
      : { prompt: input.prompt }),
  });
  // Drain the stream once and read the reported usage before the output: the
  // output accessor rejects when nothing matched the schema, and that
  // generation was still billed. Every accessor resolves from this one pass.
  let drained: [
    Awaited<typeof result.usage>,
    Awaited<typeof result.response>,
    Awaited<typeof result.finishReason>,
    Awaited<typeof result.providerMetadata>,
    string,
    Awaited<typeof result.toolCalls>,
  ];

  try {
    drained = await Promise.all([
      result.usage,
      result.response,
      result.finishReason,
      result.providerMetadata,
      result.text,
      result.toolCalls,
    ]);
  } catch (error) {
    // The provider's own error, not the SDK's stand-in for "no steps".
    throw streamFailure ?? error;
  }

  const [
    reported,
    response,
    finishReason,
    providerMetadata,
    answered,
    toolCalls,
  ] = drained;
  // An answer given as a tool call has no text; the call itself is what was
  // said, and it is retained so a schema miss of that shape can be read
  // (Opus 5 through the gateway, repair planner, 2026-09-12).
  const text =
    answered === '' && toolCalls.length > 0
      ? JSON.stringify(
          toolCalls.map((call) => {
            const callInput: unknown = call.input;

            return { tool: call.toolName, input: callInput };
          }),
        )
      : answered;
  const usage = {
    resolvedModel: servedModelOf(input.role.model, response.modelId),
    requestId: response.id,
    finishReason,
    inputTokens: reported.inputTokens,
    outputTokens: reported.outputTokens,
    cachedInputTokens: reported.inputTokenDetails.cacheReadTokens,
    reasoningTokens: reported.outputTokenDetails.reasoningTokens,
    costUsd: reportedNumber(providerMetadata?.gateway?.cost),
  };

  try {
    return { output: await result.output, text, usage };
  } catch (error) {
    // Streaming reports "answered but matched no schema" as a rejected
    // output promise carrying NoObjectGeneratedError. Catching the wrong
    // class here dropped the billed cost, the refusal reason, and the copy
    // writer's repair loop, because the retained text never reached it.
    if (!NoObjectGeneratedError.isInstance(error)) {
      throw streamFailure ?? error;
    }

    // A lone native tool call naming one of the schema's own actions is that
    // action: Opus 5 through the gateway answered a planner turn with
    // `inspect_dependencies({nodeKey})` instead of the JSON envelope, three
    // times in a row (2026-09-13). The schema still decides: a call it does
    // not admit fails below exactly as before.
    const [toolCall] = toolCalls;

    if (answered === '' && toolCalls.length === 1 && toolCall) {
      const callInput: unknown = toolCall.input;

      for (const action of [`tool:${toolCall.toolName}`, toolCall.toolName]) {
        const candidate = { action, input: callInput };

        try {
          return {
            output: wire.decode(
              wire.wrapped ? { result: candidate } : candidate,
            ),
            text,
            usage,
          };
        } catch {
          // Not this shape; try the next, then report the miss.
        }
      }
    }

    // The locally read usage carries the cost; the SDK's own copy on the
    // error does not, and dropping it left the reservation charged at its
    // estimate for the rest of the run.
    throw new StructuredOutputMissingError(
      { text, usage, issues: wire.lastFailure() },
      { cause: error },
    );
  }
};

export const structuredCallReservation = <T>(
  input: Pick<
    StructuredCallInput<T>,
    'role' | 'schema' | 'system' | 'prompt' | 'images'
  >,
) => {
  const role = internalModelRoleSchema.parse(input.role);
  const imageTokens = structuredImageTokens(input.images, role.model);
  // UTF-8 bytes bound text token count conservatively; include the JSON schema
  // and framing overhead. Keeping this below 100k avoids long-context tiers.
  const inputTokens =
    Buffer.byteLength(
      JSON.stringify({
        system: input.system,
        prompt: input.prompt,
        schema: structuredWireSchema(input.schema).wire,
        ...(input.images?.length
          ? { imageIds: input.images.map(({ id }) => id) }
          : {}),
      }),
    ) +
    2048 +
    imageTokens;

  if (inputTokens > role.maxInputTokens) {
    throw new Error('model_input_limit');
  }

  return {
    inputTokens,
    maxOutputTokens: role.maxOutputTokens,
    // Cache creation can cost more than uncached input; reserve that ceiling.
    reservedUsd:
      (inputTokens * role.pricingUsdPerMillion.input * 1.25 +
        role.maxOutputTokens * role.pricingUsdPerMillion.output) /
      1_000_000,
  };
};

/**
 * billedInvalidAnswer reads the two shapes of "the provider answered, billed,
 * and nothing matched the schema": the SDK's own NoObjectGeneratedError from a
 * non-streaming transport, and the streaming transport's
 * StructuredOutputMissingError, which carries the usage it read itself. Either
 * way the retained text and the reported usage are journaled and settled
 * before the error travels on.
 */
const billedInvalidAnswer = (
  error: unknown,
  requestedModel: string,
): { text: string | null; usage: ReportedUsage } | null => {
  if (NoObjectGeneratedError.isInstance(error)) {
    return {
      text: typeof error.text === 'string' ? error.text : null,
      usage: {
        resolvedModel: servedModelOf(requestedModel, error.response?.modelId),
        requestId: error.response?.id,
        finishReason: error.finishReason,
        inputTokens: error.usage?.inputTokens,
        outputTokens: error.usage?.outputTokens,
        cachedInputTokens: error.usage?.inputTokenDetails.cacheReadTokens,
        reasoningTokens: error.usage?.outputTokenDetails.reasoningTokens,
      },
    };
  }

  if (error instanceof StructuredOutputMissingError) {
    return { text: error.text, usage: error.usage };
  }

  return null;
};

const journal = async (
  sink: StructuredCallJournal | undefined,
  observation: StructuredCallObservation,
): Promise<void> => {
  if (!sink) {
    return;
  }

  try {
    await sink.observe(observation);
  } catch (error) {
    throw new StructuredJournalError(observation, error);
  }
};

/** The output schema as the provider receives it, for the run journal;
 * null for a schema JSON Schema cannot express (a custom refinement). */
const outputJsonSchema = (schema: z.ZodType): unknown => {
  try {
    return z.toJSONSchema(schema);
  } catch {
    // The schema still validates the answer; only its description is lost.
    return null;
  }
};

export const generateStructured = async <T>(
  input: StructuredCallInput<T>,
  transport: StructuredTransport = gatewayTransport,
): Promise<{ output: T; usage: StructuredCallUsage }> => {
  input.signal?.throwIfAborted();
  const reservation = structuredCallReservation(input);
  const callId = input.callId ?? randomUUID();
  // Observed before the reservation, which a recording accounting turns into
  // the operation's start: the request is durable before it is dispatched.
  await input.accounting.observe?.(callId, {
    kind: 'request',
    system: input.system ?? null,
    prompt: input.prompt,
    schema: outputJsonSchema(input.schema),
    role: input.role,
    images: input.images ?? [],
  });
  await input.accounting.reserve({
    callId,
    role: input.roleName,
    requestedModel: input.role.model,
    reasoningEffort: reasoningEffortOf(input.role),
    profileDigest: internalModelRoleDigest(input.role),
    ...reservation,
  });
  await input.accounting.assertOwned();
  const remainingMs = input.accounting.deadlineAt
    ? Date.parse(input.accounting.deadlineAt) - Date.now()
    : input.role.deadlineMs;

  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new ModelBudgetError('Model budget deadline reached before dispatch');
  }

  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(Math.min(input.role.deadlineMs, remainingMs)),
  ]);
  assertModelCallActive(signal);
  const start = Date.now();
  const log = createLog('InternalModel');
  const heartbeat = setInterval(
    () =>
      log.info('Model request in progress', {
        callId,
        role: input.roleName,
        model: input.role.model,
        elapsedMs: Date.now() - start,
      }),
    30_000,
  );
  heartbeat.unref();
  // Unknown failures retain their reservation: a timeout does not prove that
  // the provider did no billable work. The caller owns any repair attempt.
  let result: Awaited<ReturnType<StructuredTransport>>;

  try {
    result = await transport({ ...input, signal });
  } catch (error) {
    log.warn('Model request failed', {
      callId,
      role: input.roleName,
      model: input.role.model,
      durationMs: Date.now() - start,
      ...structuredFailureDiagnostic(error, signal),
      // Which upstream route answered, and how it ended: a route that
      // rejects a request looks identical to a schema miss without this.
      ...(error instanceof StructuredOutputMissingError
        ? {
            resolvedModel: error.usage.resolvedModel,
            finishReason: error.usage.finishReason,
            outputTokens: error.usage.outputTokens,
            // What was said and why it was refused, when the operator asked
            // for it: a schema miss with neither is undiagnosable from a log.
            ...(readEnv('AEO_HARNESS_DEBUG_ERRORS') === '1'
              ? {
                  issues: error.issues.slice(0, 3),
                  text: error.text?.slice(0, 600) ?? null,
                }
              : {}),
          }
        : {}),
    });

    if (isGatewayCreditRefusal(error)) {
      await input.accounting.assertOwned();
      assertModelCallActive(signal, error);
      await input.accounting.settle(callId, {
        requestedModel: input.role.model,
        reasoningEffort: reasoningEffortOf(input.role),
        durationMs: Date.now() - start,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        finishReason: 'gateway_credit_refused',
        valid: false,
      });
    } else {
      const billed = billedInvalidAnswer(error, input.role.model);

      if (billed) {
        await input.accounting.assertOwned();
        const invalidUsage: StructuredCallUsage = {
          ...billed.usage,
          callId,
          requestedModel: input.role.model,
          reasoningEffort: reasoningEffortOf(input.role),
          durationMs: Date.now() - start,
          valid: false,
        };
        // The provider answered and billed; retain that answer before
        // settling.
        await journal(input.journal, {
          callId,
          payload: null,
          text: billed.text,
          valid: false,
          usage: invalidUsage,
        });
        await input.accounting.observe?.(callId, {
          kind: 'response',
          payload: null,
          text: billed.text,
          valid: false,
        });

        const { callId: _invalidCallId, ...recordedInvalidUsage } =
          invalidUsage;
        await input.accounting.settle(callId, recordedInvalidUsage);

        if (invalidUsage.finishReason === 'length') {
          // eslint-disable-next-line preserve-caught-error -- The output-limit code must classify on its own; a cause would change its failure diagnostic.
          throw new Error('model_output_limit');
        }
      }
    }

    assertModelCallActive(signal, error);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }

  await input.accounting.assertOwned();
  assertModelCallActive(signal);
  const usage: StructuredCallUsage = {
    ...result.usage,
    callId,
    requestedModel: input.role.model,
    reasoningEffort: reasoningEffortOf(input.role),
    durationMs: Date.now() - start,
  };
  await journal(input.journal, {
    callId,
    payload: result.output,
    text: result.text ?? null,
    valid: true,
    usage,
  });
  await input.accounting.observe?.(callId, {
    kind: 'response',
    payload: result.output,
    text: result.text ?? null,
    valid: true,
  });

  const { callId: _callId, ...recordedUsage } = usage;
  await input.accounting.settle(callId, recordedUsage);

  if (usage.finishReason === 'length') {
    throw new Error('model_output_limit');
  }

  return { output: input.schema.parse(result.output), usage };
};
