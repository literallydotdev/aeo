import { z } from 'zod';

export const workerProviderSchema = z.enum(['claude_code', 'codex', 'cursor']);

export type WorkerProvider = z.infer<typeof workerProviderSchema>;

const fileName = z
  .string()
  .regex(
    /^(?:BRIEF\.md|RULES\.md|banlist\.json|SNAPSHOT\.md|ACTIONS\.md|FACTS\.json|SCHEMA\.json|company\/(?:COMPANY|positioning|services)\.md|PREVIOUS\/(?:config|copy|author-notes)\.json|PREVIOUS\/notes\.md|examples\/[a-z0-9-]+\.json)$/,
  );

export const workerInputSchema = z.discriminatedUnion('task', [
  z.object({ task: z.literal('version') }).strict(),
  // The daily keeper (Codex worker only): refresh the ChatGPT session and
  // store it. The worker holds the session and the store credentials; the
  // adapter only learns whether it worked and when the tokens expire.
  z
    .object({
      task: z.literal('refreshSession'),
      timeoutMs: z.number().int().min(1).max(300_000),
      // A session younger than this is left alone (a fresh seed, or a retry
      // of the same maintenance job); the adapter sets the policy.
      minAgeMs: z
        .number()
        .int()
        .min(0)
        .max(7 * 24 * 60 * 60 * 1000),
    })
    .strict(),
  z
    .object({
      task: z.literal('probe'),
      prompt: z.string().min(1).max(100_000),
      timeoutMs: z.number().int().min(1).max(300_000),
    })
    .strict(),
  z
    .object({
      task: z.literal('author'),
      prompt: z.string().min(1).max(150_000),
      files: z
        .record(fileName, z.string().max(1_000_000))
        .refine(
          (files) => JSON.stringify(files).length <= 2_000_000,
          'Working files exceed budget',
        ),
      timeoutMs: z.number().int().min(1).max(3_600_000),
      maxTurns: z.number().int().min(1).max(200),
      sessionId: z
        .string()
        .regex(/^[a-zA-Z0-9-]{1,100}$/)
        .optional(),
    })
    .strict(),
]);

export type WorkerInput = z.infer<typeof workerInputSchema>;

export const workerRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shutdown') }).strict(),
  z
    .object({
      type: z.literal('invoke'),
      id: z.string().uuid(),
      input: workerInputSchema,
    })
    .strict(),
  z.object({ type: z.literal('cancel'), id: z.string().uuid() }).strict(),
]);

export type WorkerTransport = {
  has(provider: WorkerProvider): boolean;
  invoke(
    provider: WorkerProvider,
    input: WorkerInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
};

const globalKey = Symbol.for('aeo.workerTransport');

const isWorkerTransport = (value: unknown): value is WorkerTransport => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'has' in value &&
    typeof value.has === 'function' &&
    'invoke' in value &&
    typeof value.invoke === 'function' &&
    'close' in value &&
    typeof value.close === 'function'
  );
};

export const installWorkerTransport = (transport: WorkerTransport): void => {
  Object.defineProperty(globalThis, globalKey, {
    value: transport,
    configurable: false,
  });
};

export const workerTransport = (): WorkerTransport | undefined => {
  // Only installWorkerTransport writes this slot, so anything else there is
  // treated as no transport.
  const installed: unknown = Reflect.get(globalThis, globalKey);

  return isWorkerTransport(installed) ? installed : undefined;
};

export const requireWorkerTransport = (): WorkerTransport => {
  const transport = workerTransport();

  if (!transport) {
    throw new Error(
      'Isolated worker transport is required in a Batch container.',
    );
  }

  return transport;
};

export class WorkerInvocationError extends Error {
  readonly kind: string;
  // The CLI's own account of the failure, already credential-scanned by the
  // worker (errors.ts workerFailureDetail); null when it had none to give.
  readonly detail: string | null;

  constructor(kind: string, detail: string | null = null) {
    super(kind);
    this.kind = kind;
    this.detail = detail;
    this.name = 'WorkerInvocationError';
  }
}

/**
 * isWorkerInvocationError recognizes the error by name: bootstrap and adapter
 * bundle this module separately, so errors delivered through the shared
 * transport do not share a constructor identity.
 */
export const isWorkerInvocationError = (
  error: unknown,
): error is WorkerInvocationError => {
  return (
    error instanceof Error &&
    error.name === 'WorkerInvocationError' &&
    'kind' in error &&
    typeof error.kind === 'string'
  );
};
