import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contentHash } from '../stores/content-hash';
import { isRecord } from '../lib/type-guards';
import { GroundingIntegrityError, validateGroundingBundle } from './validation';
import type { GroundingBundle, ResearchStopReason } from './schema';

export type ResearchPhase = 'author' | 'audit';

export type ResearchOwner =
  | {
      kind: 'author';
      pipelineId: string;
      jobId: string;
      batchJobId: string;
      attempt: number;
    }
  | {
      kind: 'run';
      pipelineId?: string;
      runId: string;
      batchJobId?: string;
      attempt?: number;
    };
export type ResearchProfile = {
  version: 1;
  searchProvider: 'dataforseo-google-organic-v1' | 'disabled';
  maxCandidates: number;
  maxDecisions: number;
  maxSearches: number;
  maxQueriesPerCandidate: number;
  maxDocuments: number;
  maxFetchAttempts: number;
  maxReads: number;
  elapsedMs: number;
  maxUsd: number;
  maxTokens: number;
  adjudicationReserveUsd: number;
  adjudicationReserveTokens: number;
  decisionReserveUsd: number;
  decisionReserveTokens: number;
  searchReserveUsd: number;
};

export const researchProfile = (
  phase: ResearchPhase,
  budget: Pick<
    ResearchProfile,
    | 'maxUsd'
    | 'maxTokens'
    | 'adjudicationReserveUsd'
    | 'adjudicationReserveTokens'
    | 'decisionReserveUsd'
    | 'decisionReserveTokens'
    | 'searchReserveUsd'
  >,
  {
    searchProvider = 'disabled',
  }: { searchProvider?: ResearchProfile['searchProvider'] } = {},
): ResearchProfile => {
  const profile: ResearchProfile = {
    version: 1,
    searchProvider,
    maxCandidates: 40,
    maxDecisions: phase === 'author' ? 16 : 24,
    maxSearches: phase === 'author' ? 12 : 20,
    maxQueriesPerCandidate: 2,
    maxDocuments: 12,
    maxFetchAttempts: 24,
    maxReads: phase === 'author' ? 16 : 24,
    elapsedMs: 300_000,
    ...budget,
  };

  validateResearchProfile(profile);

  return profile;
};

export const validateResearchProfile = (profile: ResearchProfile): void => {
  const positive = z.number().finite().positive();
  const count = z.number().int().nonnegative();
  const parsed = z
    .object({
      version: z.literal(1),
      searchProvider: z.enum(['disabled', 'dataforseo-google-organic-v1']),
      maxCandidates: count.max(40),
      maxDecisions: count.max(24),
      maxSearches: count.max(20),
      maxQueriesPerCandidate: count.max(2),
      maxDocuments: count.max(12),
      maxFetchAttempts: count.max(24),
      maxReads: count.max(24),
      elapsedMs: positive.max(300_000),
      maxUsd: positive,
      maxTokens: count.positive(),
      adjudicationReserveUsd: positive,
      adjudicationReserveTokens: count.positive(),
      decisionReserveUsd: positive,
      decisionReserveTokens: count.positive(),
      searchReserveUsd: z.number().finite().nonnegative(),
    })
    .strict()
    .safeParse(profile);
  if (!parsed.success) {
    throw new GroundingIntegrityError(
      `Missing or invalid research profile limits: ${parsed.error.message}.`,
      { cause: parsed.error },
    );
  }

  if (
    profile.maxUsd <= 0 ||
    profile.maxTokens <= 0 ||
    profile.elapsedMs <= 0 ||
    profile.adjudicationReserveUsd <= 0 ||
    profile.adjudicationReserveTokens <= 0 ||
    profile.maxUsd < profile.adjudicationReserveUsd ||
    profile.maxTokens < profile.adjudicationReserveTokens
  ) {
    throw new GroundingIntegrityError(
      `Research requires an explicit bounded allocation and reserved adjudication: ${profile.maxUsd} USD.`,
    );
  }
};

export type ResearchCallKind =
  'decision' | 'search' | 'fetch' | 'read' | 'adjudication';
export const researchUsageSchema = z
  .object({
    usd: z.number().finite().nonnegative(),
    tokens: z.number().int().nonnegative(),
  })
  .strict();
export type ResearchUsage = z.infer<typeof researchUsageSchema>;

export type ResearchCall = {
  id: string;
  kind: ResearchCallKind;
  signature: string;
  reservedUsd: number;
  reservedTokens: number;
  /** Confirmed usage, with reservations retained for any indeterminate calls. */
  usage?: ResearchUsage;
  state: 'pending' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  result?: unknown;
  request?: unknown;
  consumed?: boolean;
  inputDigest?: string;
  failure?: string;
};

export type ResearchSession = {
  version: 1;
  id: string;
  phase: ResearchPhase;
  revision: number;
  owner: ResearchOwner;
  inputDigest: string;
  profileDigest: string;
  profile: ResearchProfile;
  startedAt: string;
  deadlineAt: string;
  calls: ResearchCall[];
  revisionHistory: { revision: number; inputDigest: string }[];
  noProgressCount?: number;
  /** The host-issued repair identity the current revision was opened under. */
  revisionSalt?: string;
  input: unknown;
  stopReason?: ResearchStopReason;
  sourceBundle?: GroundingBundle;
  bundle?: GroundingBundle;
};

/**
 * researchCallCharge returns what a research call charges its ledger:
 * confirmed usage, otherwise the reservation it still holds.
 */
export const researchCallCharge = (call: ResearchCall): ResearchUsage => {
  return call.usage ?? { usd: call.reservedUsd, tokens: call.reservedTokens };
};

export class ResearchOwnershipError extends Error {
  constructor() {
    super('Research owner is no longer active.');
    this.name = 'ResearchOwnershipError';
  }
}

export class ResearchLimitError extends Error {
  readonly reason: 'budget_exhausted' | 'deadline';

  constructor(reason: 'budget_exhausted' | 'deadline') {
    super(`Research ${reason}.`);
    this.name = 'ResearchLimitError';
    this.reason = reason;
  }
}

export type ResearchSessionStore = {
  initialize: (args: {
    phase: ResearchPhase;
    owner: ResearchOwner;
    input: unknown;
    profile: ResearchProfile;
    deadlineAt?: string;
    /** Host-issued repair identity. It is part of `input` as well, so the
     * revision it opens has its own input digest; the store reads it here to
     * give that revision a fresh elapsed window. */
    revisionSalt?: string;
  }) => Promise<ResearchSession>;
  read: (
    phase: ResearchPhase,
    owner: ResearchOwner,
  ) => Promise<ResearchSession | null>;
  assertOwned: (session: ResearchSession) => Promise<void>;
  reserve: (
    session: ResearchSession,
    call: Omit<ResearchCall, 'id' | 'state' | 'startedAt' | 'usage'>,
  ) => Promise<ResearchCall>;
  commit: (
    session: ResearchSession,
    callId: string,
    outcome: ({ result: unknown } | { failure: string }) & {
      usage?: ResearchUsage;
    },
  ) => Promise<void>;
  stop: (session: ResearchSession, reason: ResearchStopReason) => Promise<void>;
  consumeDecision: (
    session: ResearchSession,
    callId: string,
    madeProgress: boolean,
  ) => Promise<number>;
  freezeSources: (
    session: ResearchSession,
    bundle: GroundingBundle,
  ) => Promise<void>;
  freeze: (session: ResearchSession, bundle: GroundingBundle) => Promise<void>;
};

export type SessionMap = Partial<Record<ResearchPhase, ResearchSession>>;

/**
 * validateSessionMap checks the outer shape of persisted research state. The
 * sessions inside are checked when a store method reads them.
 */
export const validateSessionMap: (
  state: unknown,
) => asserts state is SessionMap = (state) => {
  if (!isRecord(state)) {
    throw new GroundingIntegrityError(
      `Research state must be a JSON object: ${typeof state}.`,
    );
  }

  for (const phase of ['author', 'audit'] as const) {
    if (Object.hasOwn(state, phase) && !isRecord(Reflect.get(state, phase))) {
      throw new GroundingIntegrityError(
        `Persisted research phase is invalid: ${phase}.`,
      );
    }
  }
};

export type AtomicResearchStorage = {
  /** Owner validation and state replacement occur under the same lock/transaction. */
  update: <T>(
    owner: ResearchOwner,
    action: (state: SessionMap) => T,
  ) => Promise<T>;
};

/** researchStateKey returns the durable identity a research session is stored under. A measurement's
 * session belongs to its run, which a retry reopens under a new pipeline, so
 * completed research is adopted instead of paid for again. An authoring
 * session has no run and belongs to its pipeline attempt. */
export const researchStateKey = (owner: ResearchOwner): string => {
  return owner.kind === 'run' ? owner.runId : owner.pipelineId;
};

const compatibleOwner = (
  previous: ResearchOwner,
  next: ResearchOwner,
): boolean => {
  if (previous.kind !== next.kind) {
    return false;
  }

  if (previous.kind === 'author' && next.kind === 'author') {
    return previous.pipelineId === next.pipelineId;
  }

  return (
    previous.kind === 'run' &&
    next.kind === 'run' &&
    (previous.runId === next.runId ||
      (!!previous.pipelineId && previous.pipelineId === next.pipelineId))
  );
};

/**
 * researchDeadline returns when research must stop: the profile's elapsed
 * window from `startedAt`, never later than the job's own deadline.
 */
const researchDeadline = (
  startedAt: number,
  profile: ResearchProfile,
  jobDeadlineAt?: string,
): string => {
  const deadline = Math.min(
    startedAt + profile.elapsedMs,
    jobDeadlineAt ? Date.parse(jobDeadlineAt) : Infinity,
  );

  if (!Number.isFinite(deadline) || deadline <= startedAt) {
    throw new ResearchLimitError('deadline');
  }

  return new Date(deadline).toISOString();
};

const currentSession = (
  state: SessionMap,
  expected: ResearchSession,
): ResearchSession => {
  validateSessionMap(state);

  const current = state[expected.phase];

  if (
    current?.id !== expected.id ||
    current.revision !== expected.revision ||
    contentHash(current.owner) !== contentHash(expected.owner)
  ) {
    throw new ResearchOwnershipError();
  }

  validateResearchProfile(current.profile);

  if (
    contentHash(current.profile) !== current.profileDigest ||
    contentHash(current.input) !== current.inputDigest
  ) {
    throw new GroundingIntegrityError('Research session identity was changed.');
  }

  return current;
};

export const createResearchSessionStore = (
  storage: AtomicResearchStorage,
  { now = Date.now }: { now?: () => number } = {},
): ResearchSessionStore => {
  return {
    initialize: (args) =>
      storage.update(args.owner, (draft) => {
        validateSessionMap(draft);

        if ((args.phase === 'author') !== (args.owner.kind === 'author')) {
          throw new GroundingIntegrityError(
            'Research phase does not match its durable owner.',
          );
        }

        validateResearchProfile(args.profile);

        const inputDigest = contentHash(args.input);
        const profileDigest = contentHash(args.profile);
        const existing = draft[args.phase];

        if (existing) {
          if (
            !compatibleOwner(existing.owner, args.owner) ||
            existing.profileDigest !== profileDigest
          ) {
            throw new GroundingIntegrityError(
              'Research allocation cannot change during retries.',
            );
          }

          const sameJob =
            existing.owner.kind === 'author' && args.owner.kind === 'author'
              ? existing.owner.jobId === args.owner.jobId
              : existing.owner.kind === 'run' &&
                args.owner.kind === 'run' &&
                existing.owner.runId === args.owner.runId;
          if (
            sameJob &&
            (existing.owner.attempt ?? 0) > (args.owner.attempt ?? 0)
          ) {
            throw new ResearchOwnershipError();
          }

          if (existing.inputDigest !== inputDigest) {
            existing.revisionHistory.push({
              revision: existing.revision,
              inputDigest: existing.inputDigest,
            });

            existing.revision += 1;
            existing.inputDigest = inputDigest;
            existing.input = args.input;
            delete existing.bundle;
            delete existing.sourceBundle;
            delete existing.stopReason;
            existing.noProgressCount = 0;
            // A host-issued repair researches again over the same answers,
            // so it gets a fresh elapsed window; under the previous one it
            // was stopped for `deadline` before its first decision. The
            // calls stay, so the search, document and request limits still
            // count the initial work (orchestrator spec §7.4). An automatic
            // input revision keeps the fixed deadline.
            if (
              args.revisionSalt !== undefined &&
              args.revisionSalt !== existing.revisionSalt
            ) {
              existing.deadlineAt = researchDeadline(
                now(),
                args.profile,
                args.deadlineAt,
              );
              existing.revisionSalt = args.revisionSalt;
            }
          }

          existing.owner = args.owner;

          return structuredClone(existing);
        }

        const startedAt = now();
        const session: ResearchSession = {
          version: 1,
          id: randomUUID(),
          phase: args.phase,
          revision: 1,
          owner: args.owner,
          inputDigest,
          profileDigest,
          profile: args.profile,
          startedAt: new Date(startedAt).toISOString(),
          deadlineAt: researchDeadline(
            startedAt,
            args.profile,
            args.deadlineAt,
          ),
          calls: [],
          revisionHistory: [],
          ...(args.revisionSalt !== undefined
            ? { revisionSalt: args.revisionSalt }
            : {}),
          input: args.input,
        };
        draft[args.phase] = session;

        return structuredClone(session);
      }),
    read: (phase, owner) =>
      storage.update(owner, (state) => {
        validateSessionMap(state);

        return structuredClone(state[phase] ?? null);
      }),
    assertOwned: (session) =>
      storage.update(session.owner, (state) => {
        currentSession(state, session);
      }),
    reserve: (session, reservation) =>
      storage.update(session.owner, (state) => {
        const current = currentSession(state, session);

        if (current.bundle) {
          throw new GroundingIntegrityError(
            'Frozen research cannot reserve new work.',
          );
        }

        if (current.stopReason && reservation.kind !== 'adjudication') {
          throw new GroundingIntegrityError(
            'Stopped research cannot dispatch discovery.',
          );
        }

        const profile = current.profile;

        if (
          now() >= Date.parse(current.deadlineAt) &&
          reservation.kind !== 'adjudication'
        ) {
          throw new ResearchLimitError('deadline');
        }

        if (
          ![reservation.reservedUsd, reservation.reservedTokens].every(
            (value) => Number.isFinite(value) && value >= 0,
          )
        ) {
          throw new GroundingIntegrityError('Invalid research reservation.');
        }

        const charged = current.calls.reduce(
          (sum, call) => {
            const charge = researchCallCharge(call);

            return {
              usd: sum.usd + charge.usd,
              tokens: sum.tokens + charge.tokens,
            };
          },
          { usd: 0, tokens: 0 },
        );

        const adjudicationPending =
          !current.calls.some(
            (call) =>
              call.kind === 'adjudication' &&
              call.inputDigest === current.inputDigest,
          ) && reservation.kind !== 'adjudication';
        if (
          charged.usd +
            reservation.reservedUsd +
            (adjudicationPending ? profile.adjudicationReserveUsd : 0) >
            profile.maxUsd ||
          charged.tokens +
            reservation.reservedTokens +
            (adjudicationPending ? profile.adjudicationReserveTokens : 0) >
            profile.maxTokens
        ) {
          throw new ResearchLimitError('budget_exhausted');
        }

        const limits: Record<ResearchCallKind, number> = {
          decision: profile.maxDecisions,
          search: profile.maxSearches,
          fetch: profile.maxFetchAttempts,
          read: profile.maxReads,
          adjudication: 1,
        };

        if (
          current.calls.filter(
            (call) =>
              call.kind === reservation.kind &&
              (reservation.kind !== 'adjudication' ||
                call.inputDigest === current.inputDigest),
          ).length >= limits[reservation.kind]
        ) {
          throw new ResearchLimitError('budget_exhausted');
        }

        const call: ResearchCall = {
          ...reservation,
          id: randomUUID(),
          state: 'pending',
          startedAt: new Date(now()).toISOString(),
          inputDigest: current.inputDigest,
        };

        current.calls.push(call);

        return structuredClone(call);
      }),
    commit: (session, callId, outcome) =>
      storage.update(session.owner, (state) => {
        if (
          outcome.usage &&
          !researchUsageSchema.safeParse(outcome.usage).success
        ) {
          throw new GroundingIntegrityError('Invalid research usage.');
        }

        const current = currentSession(state, session);

        if (current.bundle) {
          throw new GroundingIntegrityError(
            'Frozen research cannot accept late results.',
          );
        }

        const call = current.calls.find((item) => item.id === callId);

        if (call?.state !== 'pending') {
          throw new GroundingIntegrityError(
            'Research call is missing or already committed.',
          );
        }
        // An absent receipt must leave no `usage` key: a JSON store drops an
        // explicit undefined where a structured clone keeps it, and the
        // persisted call must read the same from every backend.
        const { usage, ...recorded } = outcome;

        Object.assign(call, recorded, {
          state: 'result' in outcome ? 'completed' : 'failed',
          completedAt: new Date(now()).toISOString(),
        });

        if (usage) {
          call.usage = usage;
        }
      }),
    consumeDecision: (session, callId, madeProgress) =>
      storage.update(session.owner, (state) => {
        const current = currentSession(state, session);
        const call = current.calls.find((item) => item.id === callId);

        if (call?.kind !== 'decision' || call.state !== 'completed') {
          throw new GroundingIntegrityError(
            'Only a completed decision can be consumed.',
          );
        }

        if (!call.consumed) {
          call.consumed = true;
          current.noProgressCount = madeProgress
            ? 0
            : (current.noProgressCount ?? 0) + 1;
        }

        return current.noProgressCount ?? 0;
      }),
    stop: (session, reason) =>
      storage.update(session.owner, (state) => {
        const current = currentSession(state, session);

        if (!current.bundle) {
          current.stopReason = reason;
        }
      }),
    freezeSources: (session, bundle) =>
      storage.update(session.owner, (state) => {
        validateGroundingBundle(bundle);

        const current = currentSession(state, session);

        if (!current.stopReason || bundle.assessments.length) {
          throw new GroundingIntegrityError(
            'Source freeze requires stopped research before adjudication.',
          );
        }

        if (
          current.sourceBundle &&
          current.sourceBundle.digest !== bundle.digest
        ) {
          throw new GroundingIntegrityError(
            'Frozen source bundle cannot change.',
          );
        }

        current.sourceBundle = structuredClone(bundle);
      }),
    freeze: (session, bundle) =>
      storage.update(session.owner, (state) => {
        validateGroundingBundle(bundle);

        const current = currentSession(state, session);

        if (!current.stopReason) {
          throw new GroundingIntegrityError(
            'Research must stop before freezing.',
          );
        }

        if (
          current.sourceBundle?.sourceBundleDigest !== bundle.sourceBundleDigest
        ) {
          throw new GroundingIntegrityError(
            'Adjudication changed the frozen sources.',
          );
        }

        if (current.bundle && current.bundle.digest !== bundle.digest) {
          throw new GroundingIntegrityError('Research bundle is immutable.');
        }

        current.bundle = structuredClone(bundle);
      }),
  };
};
