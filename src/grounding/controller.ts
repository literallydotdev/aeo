import { z } from 'zod';
import { contentHash } from '../stores/content-hash';
import {
  ModelBudgetError,
  type ModelCallAccounting,
} from '../models/accounting';
import { SourceRetrievalError } from './guarded-request';
import { proposedAssessmentSchema } from './model';
import {
  adjudicationVersion,
  groundingPolicyVersion,
  groundingSchemaVersion,
  claimCandidateSchema,
  type ClaimAssessment,
  type ClaimCandidate,
  type GroundingBundle,
  type GroundingCoverage,
  type GroundingSource,
  type ResearchStopReason,
  type SavedAnswer,
} from './schema';
import {
  adjudicationEvidenceDigest,
  assessmentDigest,
  createGroundingBundle,
  GroundingIntegrityError,
  groundingDigest,
  validateCandidateOccurrences,
  validateGroundingBundle,
} from './validation';
import {
  ResearchLimitError,
  ResearchOwnershipError,
  type ResearchCall,
  type ResearchCallKind,
  type ResearchOwner,
  type ResearchPhase,
  researchCallCharge,
  type ResearchProfile,
  type ResearchSession,
  type ResearchSessionStore,
  type ResearchUsage,
} from './session';
import {
  researchActionSchema,
  researchToolResultSchema,
  researchToolTimeoutOf,
  type ExecutableResearchAction,
  type GroundingTools,
  type ResearchAction,
  type ResearchToolResult,
} from './tools';

export type GroundingDecisionInput = {
  candidates: ClaimCandidate[];
  sources: GroundingSource[];
  allowedUrls: string[];
  publicSearchTerms: readonly string[];
  previousResults: ResearchToolResult[];
  remaining: {
    decisions: number;
    searches: number;
    documents: number;
    elapsedMs: number;
  };
};

export type ProposedAssessment =
  | {
      claimId: string;
      verdict: 'supported';
      references: { sourceId: string; passageId: string }[];
      explanation: string;
    }
  | {
      claimId: string;
      verdict: 'contradicted';
      references: { sourceId: string; passageId: string }[];
      explanation: string;
      incompatibleProposition: string;
    }
  | {
      claimId: string;
      verdict: 'unresolved';
      references: { sourceId: string; passageId: string }[];
      explanation: string;
      reason: Extract<ClaimAssessment, { verdict: 'unresolved' }>['reason'];
    };
/**
 * An adjudicator can name a passage the bundle does not hold: a mistyped or
 * invented id (sourcery-ai, 2026-09-22, one digit off). The reference is
 * pruned instead of failing the run, and a verdict that rested on it becomes
 * `unresolved: not_in_sources`, because a claim whose only citation cannot be
 * resolved is exactly a claim the held sources do not support. The counts
 * keep the loss visible, as dropped claims do (schema.ts, `droppedClaims`).
 */
export const pruneUnknownReferences = (
  proposed: readonly ProposedAssessment[],
  sources: readonly GroundingBundle['sources'][number][],
): { assessments: ProposedAssessment[]; dropped: number } => {
  const held = new Set(
    sources.flatMap((source) =>
      source.passages.map((passage) => `${source.id}/${passage.id}`),
    ),
  );
  let dropped = 0;

  const assessments = proposed.map((assessment) => {
    const references = assessment.references.filter((reference) =>
      held.has(`${reference.sourceId}/${reference.passageId}`),
    );

    if (references.length === assessment.references.length) {
      return assessment;
    }

    dropped += assessment.references.length - references.length;

    // `supported` and `contradicted` both require a citation; without one the
    // held sources say nothing about the claim.
    if (assessment.verdict === 'unresolved') {
      return { ...assessment, references };
    }

    return references.length > 0
      ? { ...assessment, references }
      : {
          claimId: assessment.claimId,
          verdict: 'unresolved' as const,
          references,
          explanation: assessment.explanation,
          reason: 'not_in_sources' as const,
        };
  });

  return { assessments, dropped };
};

/** `onUsage` reports what a decision or adjudication charged the shared
 * model ledger (settled usage, else the retained reservation), called once
 * before the method resolves or rejects. It is a callback rather than part
 * of the returned value so a model that resolves the action directly, as
 * the test doubles do, still satisfies the interface; the controller records
 * the report on the session call beside its result or failure. */
export type GroundingModel = {
  decisionProfileDigest: string;
  adjudication: NonNullable<GroundingBundle['adjudication']>;
  decide: (
    input: GroundingDecisionInput,
    signal: AbortSignal,
    onUsage?: (usage: ResearchUsage) => void,
  ) => Promise<ResearchAction>;
  adjudicate: (
    bundle: GroundingBundle,
    signal: AbortSignal,
    onUsage?: (usage: ResearchUsage) => void,
  ) => Promise<ProposedAssessment[]>;
};

export type ResearchProgress = {
  phase: ResearchPhase;
  elapsedMs: number;
  attemptedRequests: number;
  completedRequests: number;
  selectedCandidates: number;
  researchedCandidates: number;
  unresolvedCandidates: number;
  remainingDecisions: number;
  remainingUsd: number;
  reason: 'researching' | 'adjudicating' | ResearchStopReason;
};

export type GroundingResearchInput = {
  phase: ResearchPhase;
  configIdentity: GroundingBundle['configIdentity'];
  runId?: string;
  reviewAsOf: string;
  baseBundle?: GroundingBundle;
  candidates: ClaimCandidate[];
  answers: readonly SavedAnswer[];
  knownUrls: readonly string[];
  publicSearchTerms: readonly string[];
  coverage: Pick<
    GroundingCoverage,
    | 'suppliedAnswers'
    | 'extractedAnswers'
    | 'truncatedAnswers'
    | 'extractionStopReason'
  >;
  store: ResearchSessionStore;
  owner: ResearchOwner;
  profile: ResearchProfile;
  model: GroundingModel;
  tools: GroundingTools;
  accounting: ModelCallAccounting;
  signal?: AbortSignal;
  jobDeadlineAt: string;
  onProgress?: (progress: ResearchProgress) => void;
  /** Host-issued repair identity: a reassessment of identical inputs opens
   * a new session revision instead of returning the frozen bundle. */
  revisionSalt?: string;
  /** Sources the host already retained (the author session's fetched
   * pages): readable and adjudicated against without a second fetch. */
  seedSources?: readonly GroundingSource[];
};

// Session calls store their request and result untyped; these helpers read
// them back through the same schemas that produced them.
const decisionRequestSchema = z.object({ inputDigest: z.string().optional() });

const parseCallAction = (call: ResearchCall): ResearchAction | undefined => {
  const parsed = researchActionSchema.safeParse(call.request);

  return parsed.success ? parsed.data : undefined;
};

const parseCallResult = (
  call: ResearchCall,
): ResearchToolResult | undefined => {
  const parsed = researchToolResultSchema.safeParse(call.result);

  return parsed.success ? parsed.data : undefined;
};

const getCallCandidateIds = (call: ResearchCall): string[] => {
  const action = parseCallAction(call);

  if (!action || action.tool === 'finish_research') {
    return [];
  }

  return action.candidateIds;
};

const getDecisionInputDigest = (call: ResearchCall): string | undefined => {
  const parsed = decisionRequestSchema.safeParse(call.request);

  return parsed.success ? parsed.data.inputDigest : undefined;
};

const isReusableResult = (result: ResearchToolResult | undefined): boolean => {
  return result !== undefined && result.kind !== 'failure';
};

const retrievalKinds = {
  search_sources: 'search',
  fetch_source: 'fetch',
  read_saved_evidence: 'read',
} as const satisfies Record<
  Exclude<ResearchAction['tool'], 'finish_research'>,
  ResearchCallKind
>;

type RetrievalKind = (typeof retrievalKinds)[keyof typeof retrievalKinds];

const isRetrievalCall = (
  call: ResearchCall,
): call is ResearchCall & { kind: RetrievalKind } => {
  return ['fetch', 'search', 'read'].includes(call.kind);
};

const getActionIdentity = (action: ExecutableResearchAction) => {
  switch (action.tool) {
    case 'search_sources': {
      return { tool: action.tool, query: action.query };
    }

    case 'fetch_source': {
      return { tool: action.tool, url: action.url };
    }

    case 'read_saved_evidence': {
      return {
        tool: action.tool,
        evidenceId: action.evidenceId,
        start: action.start,
        length: action.length,
      };
    }

    default: {
      const unhandled: never = action;

      throw new Error(`Unhandled research action: ${String(unhandled)}.`);
    }
  }
};

const getRetrieval = (call: ResearchCall & { kind: RetrievalKind }) => {
  const result = parseCallResult(call);
  const failureReason = result?.kind === 'failure' ? result.reason : null;

  const retrieval = {
    callId: call.id,
    kind: call.kind,
    status: call.state === 'pending' ? ('unknown' as const) : call.state,
    reason: call.failure ?? failureReason,
    sourceId: result?.kind === 'fetch' ? result.source.id : null,
  };

  return retrieval;
};

// Stored adjudications were checked against the provider schema before they
// were committed.
const storedAdjudicationSchema = z.array(proposedAssessmentSchema);

const completedTools = (session: ResearchSession): ResearchToolResult[] => {
  return session.calls
    .filter(
      (call) =>
        call.state === 'completed' &&
        ['search', 'fetch', 'read'].includes(call.kind) &&
        (call.kind === 'fetch' || call.inputDigest === session.inputDigest) &&
        call.result !== undefined,
    )
    .flatMap((call) => {
      const result = researchToolResultSchema.safeParse(call.result);

      if (!result.success) {
        throw new GroundingIntegrityError(
          `Committed research result is invalid for call: ${call.id}.`,
        );
      }

      return [result.data];
    });
};

const sourceContext = (
  args: GroundingResearchInput,
  session: ResearchSession,
) => {
  const results = completedTools(session);
  const sources = new Map(
    [...(args.baseBundle?.sources ?? []), ...(args.seedSources ?? [])].map(
      (source) => [source.id, source],
    ),
  );
  const urls = new Set(args.knownUrls);

  for (const source of sources.values()) {
    urls.add(source.finalUrl);
  }

  for (const result of results) {
    if (result.kind === 'search') {
      for (const lead of result.leads) {
        urls.add(lead.url);
      }
    }

    if (result.kind === 'fetch') {
      if (!sources.has(result.source.id)) {
        sources.set(result.source.id, result.source);
      }

      for (const url of result.links) {
        urls.add(url);
      }
    }
  }
  return { sources: [...sources.values()], allowedUrls: [...urls], results };
};

const assertLive = (args: GroundingResearchInput): void => {
  args.signal?.throwIfAborted();

  if (
    !Number.isFinite(Date.parse(args.jobDeadlineAt)) ||
    Date.now() >= Date.parse(args.jobDeadlineAt)
  ) {
    throw new ResearchLimitError('deadline');
  }
};

/** assertCovers requires every selected claim assessed exactly once, and no other claim. */
const assertCovers = (
  assessments: readonly { claimId: string }[],
  selected: readonly { id: string }[],
): void => {
  const selectedIds = new Set(selected.map(({ id }) => id));

  if (assessments.some(({ claimId }) => !selectedIds.has(claimId))) {
    throw new GroundingIntegrityError('Adjudicator returned an unknown claim.');
  }

  const assessed = new Set(assessments.map(({ claimId }) => claimId));

  if (
    assessments.length !== selected.length ||
    assessed.size !== selected.length
  ) {
    throw new GroundingIntegrityError(
      `Adjudication must cover every selected claim exactly once: ${assessments.length} of ${selected.length}.`,
    );
  }
};

const isIntegrity = (error: unknown): boolean => {
  return (
    error instanceof GroundingIntegrityError ||
    error instanceof ResearchOwnershipError ||
    (error instanceof ModelBudgetError &&
      !['exhausted', 'deadline'].includes(error.kind)) ||
    (error instanceof Error && error.name === 'ZodError')
  );
};

const stopForError = (
  error: unknown,
  deadlineAt: string,
): ResearchStopReason => {
  if (Date.now() >= Date.parse(deadlineAt)) {
    return 'deadline';
  }

  if (error instanceof ResearchLimitError) {
    return error.reason;
  }

  if (error instanceof ModelBudgetError) {
    return error.kind === 'deadline' ? 'deadline' : 'budget_exhausted';
  }

  return 'provider_unavailable';
};

/** Failures the search tool returns before calling its provider
 * (tools.ts): an off-vocabulary query, or no provider configured. */
const undispatchedSearchFailures: ReadonlySet<string> = new Set([
  'invalid_query',
  'unavailable',
]);

const isUndispatchedSearch = (result: ResearchToolResult): boolean => {
  return (
    result.kind === 'failure' && undispatchedSearchFailures.has(result.reason)
  );
};

export const runGroundingResearch = async (
  args: GroundingResearchInput,
): Promise<GroundingBundle> => {
  assertLive(args);

  if (args.tools.searchProvider !== args.profile.searchProvider) {
    throw new GroundingIntegrityError(
      `Research search provider differs from pinned profile: ${args.tools.searchProvider}.`,
    );
  }

  if (args.baseBundle) {
    validateGroundingBundle(args.baseBundle, {
      reportKey: args.configIdentity.reportKey,
      configVersion: args.configIdentity.configVersion,
    });
  }

  const candidates = args.candidates.map((candidate) =>
    claimCandidateSchema.parse(candidate),
  );

  for (const candidate of candidates) {
    validateCandidateOccurrences(candidate, args.answers);
  }

  const selected = candidates.filter(
    (candidate) => candidate.disposition === 'selected',
  );

  if (selected.length > args.profile.maxCandidates) {
    throw new GroundingIntegrityError(
      `Selected candidates exceed research allocation: ${selected.length}.`,
    );
  }

  let session = await args.store.initialize({
    phase: args.phase,
    owner: args.owner,
    profile: args.profile,
    deadlineAt: args.jobDeadlineAt,
    revisionSalt: args.revisionSalt,
    input: {
      configIdentity: args.configIdentity,
      runId: args.runId,
      reviewAsOf: args.reviewAsOf,
      baseBundleDigest: args.baseBundle?.digest,
      candidates,
      answerDigests: args.answers.map(({ id, digest }) => ({ id, digest })),
      knownUrls: args.knownUrls,
      publicSearchTerms: args.publicSearchTerms,
      coverage: args.coverage,
      adjudication: args.model.adjudication,
      decisionProfileDigest: args.model.decisionProfileDigest,
      ...(args.revisionSalt ? { revisionSalt: args.revisionSalt } : {}),
    },
  });

  if (session.bundle) {
    return validateGroundingBundle(session.bundle, {
      ...args.configIdentity,
      runId: args.runId,
      answers: args.answers,
    });
  }

  const refresh = async () => {
    const current = await args.store.read(args.phase, args.owner);

    if (
      current?.id !== session.id ||
      current.revision !== session.revision ||
      contentHash(current.owner) !== contentHash(session.owner)
    ) {
      throw new ResearchOwnershipError();
    }

    session = current;
    await args.store.assertOwned(session);
  };

  let stage: ResearchProgress['reason'] = session.stopReason ?? 'researching';
  const progress = () => {
    args.onProgress?.({
      phase: args.phase,
      elapsedMs: Date.now() - Date.parse(session.startedAt),
      attemptedRequests: session.calls.length,
      completedRequests: session.calls.filter(
        (call) => call.state === 'completed',
      ).length,
      selectedCandidates: selected.length,
      researchedCandidates: new Set(session.calls.flatMap(getCallCandidateIds))
        .size,
      unresolvedCandidates:
        session.bundle?.assessments.filter(
          (assessment) => assessment.verdict === 'unresolved',
        ).length ?? selected.length,
      remainingDecisions: Math.max(
        0,
        args.profile.maxDecisions -
          session.calls.filter((call) => call.kind === 'decision').length,
      ),
      remainingUsd: Math.max(
        0,
        args.profile.maxUsd -
          session.calls.reduce(
            (sum, call) => sum + researchCallCharge(call).usd,
            0,
          ),
      ),
      reason: stage,
    });
  };

  const timer = setInterval(progress, 30_000);
  timer.unref();
  progress();

  try {
    let noProgress = session.noProgressCount ?? 0;

    while (!session.stopReason) {
      assertLive(args);
      await args.store.assertOwned(session);

      let reason: ResearchStopReason | undefined;

      if (selected.length === 0) {
        reason = 'evidence_ready';
      } else if (noProgress >= 2) {
        reason = 'no_progress';
      } else if (Date.now() >= Date.parse(session.deadlineAt)) {
        reason = 'deadline';
      }

      if (reason) {
        await args.store.stop(session, reason);
        await refresh();

        break;
      }

      const context = sourceContext(args, session);
      const signature = contentHash({
        input: session.inputDigest,
        calls: session.calls.map((call) => ({
          id: call.id,
          state: call.state,
        })),
      });

      let action: ResearchAction;
      let decisionId: string;
      const savedDecision = session.calls.find(
        (call) =>
          call.kind === 'decision' &&
          call.state === 'completed' &&
          !call.consumed &&
          getDecisionInputDigest(call) === session.inputDigest,
      );

      try {
        if (savedDecision) {
          action = researchActionSchema.parse(savedDecision.result);
          decisionId = savedDecision.id;
        } else {
          const call = await args.store.reserve(session, {
            kind: 'decision',
            signature,
            reservedUsd: args.profile.decisionReserveUsd,
            reservedTokens: args.profile.decisionReserveTokens,
            request: { inputDigest: session.inputDigest },
          });

          decisionId = call.id;
          await args.store.assertOwned(session);

          let usage: ResearchUsage | undefined;

          try {
            action = researchActionSchema.parse(
              await args.model.decide(
                {
                  candidates: selected,
                  sources: context.sources,
                  allowedUrls: context.allowedUrls,
                  publicSearchTerms: args.publicSearchTerms,
                  previousResults: context.results.slice(-4),
                  remaining: {
                    decisions:
                      args.profile.maxDecisions -
                      session.calls.filter((item) => item.kind === 'decision')
                        .length -
                      1,
                    searches:
                      args.profile.maxSearches -
                      session.calls.filter((item) => item.kind === 'search')
                        .length,
                    documents:
                      args.profile.maxDocuments -
                      context.sources.length +
                      (args.baseBundle?.sources.length ?? 0),
                    elapsedMs: Math.max(
                      0,
                      Date.parse(session.deadlineAt) - Date.now(),
                    ),
                  },
                },
                AbortSignal.any([
                  ...(args.signal ? [args.signal] : []),
                  AbortSignal.timeout(
                    Math.max(1, Date.parse(session.deadlineAt) - Date.now()),
                  ),
                ]),
                (value) => {
                  usage = value;
                },
              ),
            );
            await args.store.commit(session, call.id, {
              result: action,
              usage,
            });
          } catch (error) {
            await args.store.commit(session, call.id, {
              failure:
                error instanceof ResearchLimitError
                  ? error.reason
                  : 'decision_failed',
              usage,
            });

            throw error;
          }
        }
      } catch (error) {
        args.signal?.throwIfAborted();

        if (isIntegrity(error)) {
          throw error;
        }

        await args.store.stop(session, stopForError(error, session.deadlineAt));
        await refresh();

        break;
      }

      await refresh();

      if (action.tool === 'finish_research') {
        // `evidence_ready` is a claim about work done, so it is checked
        // against the work. A researcher that finishes on its first decision
        // having searched nothing produces a bundle that is valid, complete
        // and empty — downstream indistinguishable from an audit where the
        // evidence genuinely did not exist.
        const evidenced = new Set(
          session.calls
            // A completed call whose result was a failure evidences nothing;
            // counting it let one bogus read defeat the check entirely.
            .filter(
              (call) =>
                call.state === 'completed' &&
                call.kind !== 'decision' &&
                parseCallResult(call)?.kind !== 'failure',
            )
            .flatMap(getCallCandidateIds),
        );
        const unevidenced = selected
          .filter((candidate) => !evidenced.has(candidate.id))
          .map((candidate) => candidate.id);
        // `evidence_ready` over no evidence at all is not a finish, it is a
        // researcher that never started, and the honest recorded reason is
        // that the sources were not found. That is decided here, not asked
        // again: another decision would only buy the same answer from a
        // model that has, by construction, looked at nothing since the last.
        await args.store.stop(
          session,
          action.reason === 'evidence_ready' &&
            unevidenced.length === selected.length &&
            selected.length
            ? 'sources_exhausted'
            : action.reason,
        );
        await refresh();

        break;
      }
      // An unselected claim id controls nothing but attribution and the
      // per-candidate query budget, so it refuses the action rather than
      // discarding every source and search the session already committed.
      // The decision MUST be consumed: the loop replays a completed,
      // unconsumed decision from the journal, so continuing without
      // consuming re-executes the same bad action forever, rewriting the
      // run's row thousands of times a second until the deadline.
      if (
        action.candidateIds.some(
          (id) => !selected.some((candidate) => candidate.id === id),
        )
      ) {
        noProgress = await args.store.consumeDecision(
          session,
          decisionId,
          false,
        );
        await refresh();

        if (noProgress >= 2) {
          await args.store.stop(session, 'no_progress');
          await refresh();

          break;
        }

        continue;
      }

      const actionSignature = contentHash({
        input: session.inputDigest,
        action: getActionIdentity(action),
      });

      const reused = session.calls.find(
        (call) =>
          call.signature === actionSignature &&
          call.state === 'completed' &&
          isReusableResult(parseCallResult(call)),
      );
      let madeProgress = false;

      if (reused) {
        noProgress += 1;
      } else {
        const kind = retrievalKinds[action.tool];
        try {
          if (action.tool === 'search_sources') {
            for (const candidateId of action.candidateIds) {
              const queries = new Set(
                session.calls
                  .filter((call) => call.kind === 'search')
                  .flatMap((call) => {
                    const request = parseCallAction(call);

                    return request?.tool === 'search_sources' &&
                      request.candidateIds.includes(candidateId)
                      ? [request.query]
                      : [];
                  }),
              );

              if (
                !queries.has(action.query) &&
                queries.size >= args.profile.maxQueriesPerCandidate
              ) {
                throw new ResearchLimitError('budget_exhausted');
              }
            }
          }

          if (action.tool === 'fetch_source') {
            // The document allowance counts documents actually retrieved,
            // from each call's outcome. Counting requests charged a refused
            // URL (`invalid_reference`, never fetched) a slot; attempts have
            // their own limit in the session ledger.
            const documents = new Set(
              session.calls.flatMap((call) => {
                const request = parseCallAction(call);
                const result = parseCallResult(call);

                return request?.tool === 'fetch_source' &&
                  result?.kind === 'fetch'
                  ? [request.url]
                  : [];
              }),
            );

            if (
              !documents.has(action.url) &&
              documents.size >= args.profile.maxDocuments
            ) {
              throw new ResearchLimitError('budget_exhausted');
            }
          }

          const call = await args.store.reserve(session, {
            kind,
            signature: actionSignature,
            reservedUsd: kind === 'search' ? args.profile.searchReserveUsd : 0,
            reservedTokens: 0,
            request: action,
          });

          if (kind === 'search') {
            await args.accounting.reserve({
              callId: call.id,
              role: 'research_search',
              reservedUsd: args.profile.searchReserveUsd,
              inputTokens: 0,
              maxOutputTokens: 0,
            });
          }

          await args.accounting.assertOwned();
          await args.store.assertOwned(session);

          const before = contentHash({
            sources: context.sources.map((source) => source.id),
            urls: context.allowedUrls,
            failures: [
              ...new Set(
                context.results
                  .filter((result) => result.kind === 'failure')
                  .map(contentHash),
              ),
            ],
            reads: [
              ...new Set(
                context.results
                  .filter((result) => result.kind === 'read')
                  .map(contentHash),
              ),
            ],
          });

          let requestCount = 0;
          let result: ResearchToolResult;

          try {
            result = researchToolResultSchema.parse(
              await args.tools.execute(action, {
                sources: context.sources,
                allowedUrls: context.allowedUrls,
                signal: AbortSignal.any([
                  ...(args.signal ? [args.signal] : []),
                  AbortSignal.timeout(
                    Math.max(
                      1,
                      Math.min(
                        researchToolTimeoutOf(action),
                        Date.parse(session.deadlineAt) - Date.now(),
                      ),
                    ),
                  ),
                ]),
                beforeFetchRequest: async () => {
                  if (requestCount++ > 0) {
                    await args.store.reserve(session, {
                      kind: 'fetch',
                      signature: `${call.id}:redirect:${requestCount}`,
                      reservedUsd: 0,
                      reservedTokens: 0,
                    });
                  }

                  await args.store.assertOwned(session);
                },
              }),
            );

            if (result.kind === 'search' && result.reportedCostUsd !== null) {
              await args.accounting.settle(call.id, {
                costUsd: result.reportedCostUsd,
                inputTokens: 0,
                outputTokens: 0,
                requestId: result.providerRequestId,
              });
            }

            // A search the tools refused before dispatch reached no provider:
            // it cost nothing, and its outcome is known.
            if (kind === 'search' && isUndispatchedSearch(result)) {
              await args.accounting.settle(call.id, {
                costUsd: 0,
                inputTokens: 0,
                outputTokens: 0,
              });
            }
          } catch (error) {
            args.signal?.throwIfAborted();

            if (isIntegrity(error) || error instanceof ResearchLimitError) {
              throw error;
            }

            result = {
              kind: 'failure',
              reason:
                error instanceof SourceRetrievalError &&
                error.reason === 'unsafe_destination'
                  ? 'unsafe_destination'
                  : 'retrieval_failed',
              retryable: false,
            };
          }

          await args.store.commit(session, call.id, {
            result,
            usage:
              kind === 'search' && isUndispatchedSearch(result)
                ? { usd: 0, tokens: 0 }
                : undefined,
          });
          await refresh();

          const after = sourceContext(args, session);
          const fingerprint = contentHash({
            sources: after.sources.map((source) => source.id),
            urls: after.allowedUrls,
            failures: [
              ...new Set(
                after.results
                  .filter((result) => result.kind === 'failure')
                  .map(contentHash),
              ),
            ],
            reads: [
              ...new Set(
                after.results
                  .filter((result) => result.kind === 'read')
                  .map(contentHash),
              ),
            ],
          });

          madeProgress = fingerprint !== before;
          noProgress = madeProgress ? 0 : noProgress + 1;
        } catch (error) {
          args.signal?.throwIfAborted();

          if (isIntegrity(error)) {
            throw error;
          }

          await args.store.stop(
            session,
            stopForError(error, session.deadlineAt),
          );
          await refresh();

          break;
        }
      }

      noProgress = await args.store.consumeDecision(
        session,
        decisionId,
        madeProgress,
      );
      await refresh();

      if (noProgress >= 2) {
        await args.store.stop(session, 'no_progress');
        await refresh();
      }

      progress();
    }

    assertLive(args);
    await args.store.assertOwned(session);
    stage = 'adjudicating';
    progress();

    let frozen = session.sourceBundle;

    if (!frozen) {
      const context = sourceContext(args, session);
      const { stopReason } = session;

      if (!stopReason) {
        throw new GroundingIntegrityError(
          `Research session ended without a stop reason: ${session.id}.`,
        );
      }

      frozen = createGroundingBundle({
        schemaVersion: groundingSchemaVersion,
        policyVersion: groundingPolicyVersion,
        configIdentity: args.configIdentity,
        ...(args.runId ? { runId: args.runId } : {}),
        reviewAsOf: args.reviewAsOf,
        sources: context.sources,
        facts: args.baseBundle?.facts ?? [],
        candidates,
        assessments: [],
        adjudication: null,
        coverage: {
          ...args.coverage,
          selectedCandidates: selected.length,
          overflowCandidates: candidates.filter(
            (candidate) => candidate.disposition === 'overflow',
          ).length,
          stopReason,
          retrievals: session.calls.filter(isRetrievalCall).map(getRetrieval),
          gaps: context.results.some((result) => result.kind === 'failure')
            ? [
                {
                  candidateIds: selected.map((candidate) => candidate.id),
                  reason: 'retrieval_failed',
                },
              ]
            : [],
        },
      });

      await args.store.freezeSources(session, frozen);
    }

    // A completed adjudication is keyed by the evidence it judged, so a
    // repair revision that gathered nothing new reuses it rather than paying
    // for the same judgement over identical sources; its coverage may still
    // differ (a different stop reason, a failed retrieval), which is why the
    // source bundle digest is not the key. Sessions frozen before this key
    // existed stored the exact source digest, and that match still counts.
    const adjudicationKey = adjudicationEvidenceDigest(
      frozen,
      args.model.adjudication,
    );

    const completed = session.calls.find(
      (call) =>
        call.kind === 'adjudication' &&
        call.state === 'completed' &&
        (call.signature === adjudicationKey ||
          call.signature === frozen.sourceBundleDigest),
    );
    let proposed: ProposedAssessment[];

    if (completed) {
      proposed = storedAdjudicationSchema.parse(completed.result);
    } else if (selected.length === 0) {
      proposed = [];
    } else {
      try {
        const call = await args.store.reserve(session, {
          kind: 'adjudication',
          signature: adjudicationKey,
          reservedUsd: args.profile.adjudicationReserveUsd,
          reservedTokens: args.profile.adjudicationReserveTokens,
        });

        await args.store.assertOwned(session);

        let usage: ResearchUsage | undefined;

        try {
          proposed = await args.model.adjudicate(
            frozen,
            AbortSignal.any([
              ...(args.signal ? [args.signal] : []),
              AbortSignal.timeout(
                Math.max(1, Date.parse(args.jobDeadlineAt) - Date.now()),
              ),
            ]),
            (value) => {
              usage = value;
            },
          );

          // Refuse before committing: a stored result is replayed by every
          // later attempt, so one that cannot be accepted must never be kept.
          assertCovers(proposed, selected);
          await args.store.commit(session, call.id, {
            result: proposed,
            usage,
          });
        } catch (error) {
          await args.store.commit(session, call.id, {
            failure: 'adjudication_failed',
            usage,
          });

          throw error;
        }
      } catch (error) {
        args.signal?.throwIfAborted();

        if (isIntegrity(error)) {
          throw error;
        }

        proposed = selected.map((candidate) => ({
          claimId: candidate.id,
          verdict: 'unresolved',
          references: [],
          explanation:
            'Claim assessment could not be completed within the recorded allocation.',
          reason:
            error instanceof ResearchLimitError ||
            error instanceof ModelBudgetError
              ? 'budget_exhausted'
              : 'provider_unavailable',
        }));
      }
    }

    const pruned = pruneUnknownReferences(proposed, frozen.sources);
    const assessed = pruned.assessments.map((assessment) => {
      const candidate = selected.find((item) => item.id === assessment.claimId);

      if (!candidate) {
        throw new GroundingIntegrityError(
          `Adjudicator returned an unknown claim: ${assessment.claimId}.`,
        );
      }

      const value = {
        ...assessment,
        scope: candidate.scope,
        sourceBundleDigest: frozen.sourceBundleDigest,
      };

      return {
        candidate,
        assessment: { ...value, digest: assessmentDigest(value) },
      };
    });

    const assessments = assessed.map(({ assessment }) => assessment);

    assertCovers(assessments, selected);

    const facts =
      args.phase === 'author'
        ? assessed.map(({ candidate, assessment }) => ({
            id: candidate.id,
            proposition: candidate.proposition,
            scope: candidate.scope,
            references: assessment.references,
            status:
              assessment.verdict === 'supported'
                ? ('supported' as const)
                : ('unresolved' as const),
            reason: assessment.explanation,
          }))
        : frozen.facts;

    const final: GroundingBundle = {
      ...frozen,
      facts,
      assessments,
      adjudication: {
        ...args.model.adjudication,
        policyVersion: adjudicationVersion,
        ...(pruned.dropped ? { droppedReferences: pruned.dropped } : {}),
      },
    };

    const bundle = validateGroundingBundle(
      { ...final, digest: groundingDigest(final) },
      { ...args.configIdentity, runId: args.runId, answers: args.answers },
    );

    assertLive(args);
    await args.store.freeze(session, bundle);
    await refresh();

    if (!session.stopReason) {
      throw new GroundingIntegrityError(
        `Frozen research session has no stop reason: ${session.id}.`,
      );
    }

    stage = session.stopReason;
    progress();

    return bundle;
  } finally {
    clearInterval(timer);
  }
};
