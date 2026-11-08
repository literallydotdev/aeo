import { z } from 'zod';
import {
  ModelBudgetError,
  type ModelCallAccounting,
} from '../models/accounting';
import type { InternalModelRoleConfig } from '../models/profiles';
import {
  generateStructured,
  type StructuredTransport,
} from '../models/structured';
import { contentHash } from '../stores/content-hash';
import { locateVerbatimPassage } from '../analysis/verbatim';
import {
  type ClaimCandidate,
  type GroundingCoverage,
  type SavedAnswer,
  productScopeSchema,
} from './schema';
import {
  GroundingIntegrityError,
  validateCandidateOccurrences,
} from './validation';
import { groundingRules } from './model';

const maxAnswerChars = 16_000;
const defaultExtractionBatchSize = 3;

/**
 * extractionBatchSize returns the answers per extraction call: the default
 * above, or the narrower ceiling a reasoning model pins on its role,
 * whichever is smaller. Without this the pin would reach the batched analysis
 * calls and silently miss this one.
 */
const extractionBatchSize = (role: InternalModelRoleConfig): number => {
  return Math.min(defaultExtractionBatchSize, role.maxItemsPerCall ?? Infinity);
};

const defaultExtractionConcurrency = 4;
const maxClaimsPerBatch = 40;

// Raw model proposals remain reusable; normalized inventories have a separate policy identity.
export const candidateInventoryPolicyVersion = 2;

const extractionSystem = `${groundingRules}\nExtract material, checkable atomic claims about the audited product. Do not judge accuracy or use a product brief as evidence. Prioritize identity, lifecycle, compatibility and capability assertions. Preserve negation, qualifiers, product generations and relevant time; use null when time/version is unknown. Return an exact, unique contiguous quotation from the supplied answer for each claim; include enough surrounding text to make its offsets unambiguous. Use only supplied answer IDs. Split compound statements whose parts require different evidence. Ordinary positioning adjectives are not factual claims.`;

export const claimExtractionSchema = z.object({
  claims: z
    .array(
      z.object({
        answerId: z.string().min(1),
        proposition: z.string().min(1).max(2000),
        quote: z.string().min(1).max(8000),
        scope: productScopeSchema,
        category: z.enum([
          'identity',
          'lifecycle',
          'compatibility',
          'capability',
          'other',
        ]),
        inAuditedProductScope: z.boolean(),
      }),
    )
    .max(maxClaimsPerBatch),
});

type ExtractedClaim = z.infer<typeof claimExtractionSchema>['claims'][number];

export const validatedExtractionBatchSchema = z
  .object({
    kind: z.literal('validated_extraction_batch'),
    version: z.literal(1),
    key: z.string().min(1),
    callId: z.string().min(1),
    output: claimExtractionSchema,
  })
  .strict();
export type ValidatedExtractionBatch = z.infer<
  typeof validatedExtractionBatchSchema
>;

export type ClaimExtractionBatchCache = {
  get: (key: string) => Promise<ValidatedExtractionBatch | null | undefined>;
  put: (key: string, batch: ValidatedExtractionBatch) => Promise<void>;
};

export const claimExtractionIdentity = (
  product: string,
  role: InternalModelRoleConfig,
): string => {
  return contentHash({
    version: 1,
    product,
    roleDigest: contentHash(role),
    promptDigest: contentHash(extractionSystem),
    schemaDigest: contentHash(z.toJSONSchema(claimExtractionSchema)),
    maxAnswerChars,
    batchSize: extractionBatchSize(role),
  });
};

export type ClaimExtractionDiagnostic = {
  kind: 'untrusted_extraction_diagnostic';
  version: 1;
  trusted: false;
  reason: 'unknown_answer_id' | 'quote_not_found' | 'quote_ambiguous';
  batchIndex: number;
  batchStart: number;
  claimIndex: number;
  callId: string;
  suppliedAnswers: Array<{
    answerId: string;
    answerDigest: string;
    suppliedTextDigest: string;
    suppliedChars: number;
  }>;
  rawOutput: z.infer<typeof claimExtractionSchema>;
};

// A quote that is not in its answer even through formatting is a quoting slip
// of one generation, not evidence about the answer: it gets bounded
// regeneration before the batch is refused as untrusted.
const extractionQuoteAttempts = 3;

type QuoteProblem = {
  reason: ClaimExtractionDiagnostic['reason'];
  claimIndex: number;
};

/**
 * canonicalizeQuotes replaces every quote with its answer's own passage where
 * only formatting differs (markdown, whitespace, quote glyphs). The candidate
 * inventory needs literal, unique substrings for its occurrence offsets.
 */
const canonicalizeQuotes = (
  output: z.infer<typeof claimExtractionSchema>,
  batch: readonly Pick<SavedAnswer, 'id' | 'text'>[],
): z.infer<typeof claimExtractionSchema> => {
  return {
    ...output,
    claims: output.claims.map((claim) => {
      const answer = batch.find((item) => item.id === claim.answerId);
      const passage =
        answer &&
        locateVerbatimPassage(
          answer.text.slice(0, maxAnswerChars),
          claim.quote,
        );
      return passage ? { ...claim, quote: passage } : claim;
    }),
  };
};

const quoteProblem = (
  output: z.infer<typeof claimExtractionSchema>,
  batch: readonly Pick<SavedAnswer, 'id' | 'text'>[],
): QuoteProblem | null => {
  for (const [claimIndex, claim] of output.claims.entries()) {
    const answer = batch.find((item) => item.id === claim.answerId);

    if (!answer) {
      return { reason: 'unknown_answer_id', claimIndex };
    }

    const quoteStart = answer.text.indexOf(claim.quote);

    if (!answer.text.slice(0, maxAnswerChars).includes(claim.quote)) {
      return { reason: 'quote_not_found', claimIndex };
    }

    if (answer.text.indexOf(claim.quote, quoteStart + 1) >= 0) {
      return { reason: 'quote_ambiguous', claimIndex };
    }
  }

  return null;
};

const englishMonths = [
  'Jan(?:uary)?',
  'Feb(?:ruary)?',
  'Mar(?:ch)?',
  'Apr(?:il)?',
  'May',
  'Jun(?:e)?',
  'Jul(?:y)?',
  'Aug(?:ust)?',
  'Sep(?:t(?:ember)?)?',
  'Oct(?:ober)?',
  'Nov(?:ember)?',
  'Dec(?:ember)?',
];

const ordinalSuffixes: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };

const getOrdinalSuffix = (day: number): string => {
  if (day >= 11 && day <= 13) {
    return 'th';
  }

  return ordinalSuffixes[day % 10] ?? 'th';
};

const normalizedApplicableAt = (
  item: ExtractedClaim,
  answer: SavedAnswer,
): string | null => {
  const proposed = item.scope.applicableAt;

  if (proposed === null) {
    return null;
  }

  if (
    answer.capturedAt !== null &&
    Date.parse(proposed) === Date.parse(answer.capturedAt)
  ) {
    return proposed;
  }

  const calendarDay = proposed.slice(0, 10);
  const [year, month, day] = calendarDay.split('-').map(Number);

  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }

  const monthName = englishMonths[month - 1];

  if (!Number.isInteger(year) || !monthName || day < 1 || day > 31) {
    return null;
  }

  // Match a complete day in the exact quoted span, never nearby answer text,
  // the proposition alone, or a default first/last day inferred from a year/month.
  if (new RegExp(`\\b${calendarDay}(?=\\b|T\\d{2}:)`).test(item.quote)) {
    return proposed;
  }

  const ordinal = getOrdinalSuffix(day);
  const dayPattern = `${day < 10 ? '0?' : ''}${day}(?:${ordinal})?`;
  const monthPattern = `(?:${monthName})\\.?`;
  const separator = '(?:\\s*,\\s*|\\s+)';
  const fullDate = new RegExp(
    `\\b(?:${monthPattern}\\s+${dayPattern}${separator}${year}|${dayPattern}\\s+(?:of\\s+)?${monthPattern}${separator}${year})\\b`,
    'i',
  );
  return fullDate.test(item.quote) ? proposed : null;
};

export const buildCandidateInventory = (
  extracted: readonly ExtractedClaim[],
  answers: readonly SavedAnswer[],
  { limit = 40 }: { limit?: number } = {},
): ClaimCandidate[] => {
  if (extracted.length > 1000) {
    throw new GroundingIntegrityError(
      `Claim inventory exceeds bound: ${extracted.length}.`,
    );
  }

  const inventory: ClaimCandidate[] = [];
  const priorities = {
    lifecycle: 0,
    compatibility: 1,
    capability: 2,
    identity: 3,
    other: 4,
  };

  for (const item of extracted) {
    const answer = answers.find((value) => value.id === item.answerId);

    if (!answer) {
      throw new GroundingIntegrityError(
        'Extraction references an unknown or changed answer.',
      );
    }

    if (answer.digest !== contentHash(answer.text)) {
      throw new GroundingIntegrityError(
        'Extraction references an unknown or changed answer.',
      );
    }

    const start = answer.text.indexOf(item.quote);

    if (start < 0 || answer.text.indexOf(item.quote, start + 1) >= 0) {
      throw new GroundingIntegrityError(
        'Extraction quote is missing or ambiguous; supply more surrounding context.',
      );
    }

    const occurrence = {
      answerId: answer.id,
      runId: answer.runId,
      section: answer.section,
      promptId: answer.promptId,
      surface: answer.surface,
      runIndex: answer.runIndex,
      capturedAt: answer.capturedAt,
      answerDigest: answer.digest,
      start,
      end: start + item.quote.length,
      quote: item.quote,
    };

    const scope = {
      ...item.scope,
      applicableAt: normalizedApplicableAt(item, answer),
    };

    const candidate: ClaimCandidate = {
      id: `claim_${contentHash({ proposition: item.proposition, scope, occurrence }).slice(0, 32)}`,
      proposition: item.proposition,
      scope,
      category: item.category,
      occurrences: [occurrence],
      disposition: item.inAuditedProductScope ? 'selected' : 'outside_scope',
      duplicateOf: null,
      priority: 0,
    };

    validateCandidateOccurrences(candidate, answers);

    if (!inventory.some((entry) => entry.id === candidate.id)) {
      inventory.push(candidate);
    }
  }
  // Count repeated propositions before ordering, preserving the original occurrence records.
  const groupKey = (candidate: ClaimCandidate) => {
    return contentHash({
      proposition: candidate.proposition,
      scope: candidate.scope,
      time:
        candidate.scope.applicableAt ?? candidate.occurrences[0]?.capturedAt,
    });
  };

  const counts = new Map<string, number>();

  for (const candidate of inventory) {
    counts.set(
      groupKey(candidate),
      (counts.get(groupKey(candidate)) ?? 0) + candidate.occurrences.length,
    );
  }

  const getCount = (candidate: ClaimCandidate): number => {
    const count = counts.get(groupKey(candidate));

    if (count === undefined) {
      throw new GroundingIntegrityError(
        `Claim inventory has no count for candidate: ${candidate.id}.`,
      );
    }

    return count;
  };

  inventory.sort(
    (left, right) =>
      priorities[left.category] - priorities[right.category] ||
      getCount(right) - getCount(left) ||
      left.id.localeCompare(right.id),
  );

  const selected = new Map<string, ClaimCandidate>();

  // The inventory owns these candidates, so ranking updates them in place.
  for (const [priority, candidate] of inventory.entries()) {
    candidate.priority = priority;

    if (candidate.disposition === 'outside_scope') {
      continue;
    }

    const previous = selected.get(groupKey(candidate));

    if (previous) {
      candidate.disposition = 'duplicate';
      candidate.duplicateOf = previous.id;
      previous.occurrences.push(...candidate.occurrences);

      continue;
    }

    if (selected.size >= limit) {
      candidate.disposition = 'overflow';
    } else {
      selected.set(groupKey(candidate), candidate);
    }
  }

  return inventory;
};

export const extractClaimCandidates = async (args: {
  answers: readonly SavedAnswer[];
  product: string;
  role: InternalModelRoleConfig;
  accounting: ModelCallAccounting;
  signal?: AbortSignal;
  transport?: StructuredTransport;
  concurrency?: number;
  batchCache?: ClaimExtractionBatchCache;
  // Host-derived from validated capture provenance, never model-proposed IDs.
  priorAnswerRunIds?: Readonly<Record<string, string>>;
  onProgress?: (progress: {
    batchIndex: number;
    completedBatches: number;
    totalBatches: number;
    cached: boolean;
  }) => void;
  onDiagnostic?: (diagnostic: ClaimExtractionDiagnostic) => Promise<void>;
}): Promise<{
  candidates: ClaimCandidate[];
  coverage: Pick<
    GroundingCoverage,
    | 'suppliedAnswers'
    | 'extractedAnswers'
    | 'truncatedAnswers'
    | 'extractionStopReason'
    | 'droppedClaims'
    | 'droppedClaimsByAnswer'
  >;
}> => {
  if (args.answers.length > 500) {
    throw new GroundingIntegrityError(
      `Answer extraction inventory exceeds bounded input: ${args.answers.length}.`,
    );
  }

  const concurrency = args.concurrency ?? defaultExtractionConcurrency;

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new GroundingIntegrityError(
      `Extraction concurrency must be 1 to 4: ${concurrency}.`,
    );
  }

  for (const answer of args.answers) {
    if (answer.digest !== contentHash(answer.text)) {
      throw new GroundingIntegrityError(
        `Extraction answer digest mismatch: ${answer.id}.`,
      );
    }
  }

  const batchSize = extractionBatchSize(args.role);
  const cacheIdentity = claimExtractionIdentity(args.product, args.role);
  const inFlight = new Set<string>();
  let completedBatches = 0;
  type BatchResult =
    | {
        kind: 'success';
        output: z.infer<typeof claimExtractionSchema>;
        /** The answer of each claim pruned for an unlocatable quotation. */
        droppedAnswerIds: string[];
      }
    | {
        kind: 'stop';
        reason: 'budget_exhausted' | 'provider_unavailable';
        retryReservation: boolean;
      };
  const runBatch = async (start: number): Promise<BatchResult> => {
    args.signal?.throwIfAborted();

    const batch = args.answers.slice(start, start + batchSize);
    const suppliedAnswers = batch.map((answer) => ({
      id: answer.id,
      capturedAt: answer.capturedAt,
      text: answer.text.slice(0, maxAnswerChars),
      truncated: answer.text.length > maxAnswerChars,
    }));

    const batchKey = (priorRunIds?: Readonly<Record<string, string>>) => {
      return `claim-extraction-batch:${contentHash({
        extractionIdentity: cacheIdentity,
        answers: batch.map(({ text: _text, ...answer }) =>
          priorRunIds ? { ...answer, runId: priorRunIds[answer.id] } : answer,
        ),
        suppliedAnswersDigest: contentHash(suppliedAnswers),
      })}`;
    };

    const key = batchKey();
    let lookupKey = key;
    let cached = await args.batchCache?.get(lookupKey);
    const priorRunIds = args.priorAnswerRunIds;

    if (
      !cached &&
      priorRunIds &&
      batch.every((answer) => {
        const priorRunId = priorRunIds[answer.id];

        return (
          Object.hasOwn(priorRunIds, answer.id) &&
          typeof priorRunId === 'string' &&
          priorRunId.length > 0
        );
      }) &&
      batch.some((answer) => priorRunIds[answer.id] !== answer.runId)
    ) {
      // Only the proved origin run identity differs. Text, digests, timestamps,
      // slots, product and model rules must still match the exact legacy key.
      lookupKey = batchKey(priorRunIds);
      cached = await args.batchCache?.get(lookupKey);
    }

    let output: z.infer<typeof claimExtractionSchema>;
    let rawOutput: z.infer<typeof claimExtractionSchema>;
    let callId: string;
    const batchIndex = start / batchSize;
    const reportDiagnostic = async (problem: QuoteProblem) => {
      await args.onDiagnostic?.({
        kind: 'untrusted_extraction_diagnostic',
        version: 1,
        trusted: false,
        reason: problem.reason,
        batchIndex,
        batchStart: start,
        claimIndex: problem.claimIndex,
        callId,
        suppliedAnswers: batch.map((item) => ({
          answerId: item.id,
          answerDigest: item.digest,
          suppliedTextDigest: contentHash(item.text.slice(0, maxAnswerChars)),
          suppliedChars: item.text.slice(0, maxAnswerChars).length,
        })),
        rawOutput,
      });
    };

    if (cached) {
      const validated = validatedExtractionBatchSchema.parse(cached);

      if (validated.key !== lookupKey) {
        throw new GroundingIntegrityError(
          `Extraction batch cache identity mismatch: ${validated.key}.`,
        );
      }

      output = validated.output;
      rawOutput = output;
      callId = validated.callId;
    } else {
      for (let attempt = 1; ; attempt += 1) {
        let reservedCallId: string | undefined;
        let deniedWhileInFlight = false;
        const accounting: ModelCallAccounting = {
          deadlineAt: args.accounting.deadlineAt,
          assertOwned: () => args.accounting.assertOwned(),
          // Forwarded so a recording accounting still sees the request.
          observe: (id, evidence) =>
            args.accounting.observe?.(id, evidence) ?? Promise.resolve(),
          settle: (id, usage) => args.accounting.settle(id, usage),
          release: (id) => args.accounting.release(id),
          reserve: async (call) => {
            const hadInFlight = inFlight.size > 0;

            try {
              await args.accounting.reserve(call);
              reservedCallId = call.callId;
              inFlight.add(call.callId);
            } catch (error) {
              deniedWhileInFlight =
                error instanceof ModelBudgetError &&
                error.kind === 'exhausted' &&
                (hadInFlight || inFlight.size > 0);
              throw error;
            }
          },
        };

        try {
          // Constrain generation to the exact batch identities. This encodes the
          // existing host membership check without changing canonical IDs, the
          // semantic prompt, or the identity of previously validated caches.
          const batchSchema = claimExtractionSchema.extend({
            claims: claimExtractionSchema.shape.claims.element
              .extend({ answerId: z.enum(batch.map((answer) => answer.id)) })
              .array()
              .max(maxClaimsPerBatch),
          });

          const generated = await generateStructured(
            {
              roleName: 'perception_claim_extraction',
              role: args.role,
              schema: batchSchema,
              system: extractionSystem,
              prompt: JSON.stringify({
                product: args.product,
                answers: suppliedAnswers,
              }),
              signal: args.signal,
              accounting,
            },
            args.transport,
          );

          rawOutput = generated.output;
          callId = generated.usage.callId;
          output = canonicalizeQuotes(rawOutput, batch);
        } catch (error) {
          args.signal?.throwIfAborted();

          if (
            error instanceof ModelBudgetError &&
            !['exhausted', 'deadline'].includes(error.kind)
          ) {
            throw error;
          }

          if (
            error instanceof Error &&
            (error.name === 'ZodError' ||
              error.name === 'GroundingIntegrityError')
          ) {
            throw error;
          }

          return {
            kind: 'stop',
            reason:
              error instanceof ModelBudgetError
                ? 'budget_exhausted'
                : 'provider_unavailable',
            // This is a failed admission, never a repeated provider dispatch.
            // The same ledger decides again after all wave reservations settle.
            retryReservation: !reservedCallId && deniedWhileInFlight,
          };
        } finally {
          if (reservedCallId) {
            inFlight.delete(reservedCallId);
          }
        }

        const slip = quoteProblem(output, batch);

        if (!slip || attempt >= extractionQuoteAttempts) {
          break;
        }

        await reportDiagnostic(slip);
      }
    }
    // A quote that still will not locate after the bounded regeneration is
    // one unusable claim. Dropping it keeps the guarantee — no claim reaches
    // a reader without its answer's own words — while the up to thirty-nine
    // claims beside it, each independently verified, survive. Failing the
    // batch here failed the whole run over one quoting slip. The drop is
    // not silent: the private diagnostic keeps the untrusted output, and the
    // bundle's coverage counts what was lost, per answer, so a seal receipt
    // or status can show it (orchestrator spec invariant 5).
    //
    // A cached batch is different: that is stored data the host produced and
    // proved once, so a quote that no longer locates means the entry is
    // corrupt, and a corrupt entry is refused rather than quietly pruned.
    let problem = quoteProblem(output, batch);

    if (problem && cached) {
      await reportDiagnostic(problem);
      throw new GroundingIntegrityError(
        `Extraction ${problem.reason} (batchIndex=${batchIndex}, callId=${callId}).`,
      );
    }

    const droppedAnswerIds: string[] = [];

    while (problem) {
      await reportDiagnostic(problem);

      const { claimIndex } = problem;
      const droppedClaim = output.claims[claimIndex];

      if (!droppedClaim) {
        throw new GroundingIntegrityError(
          `Extraction problem names a missing claim index: ${claimIndex}.`,
        );
      }

      droppedAnswerIds.push(droppedClaim.answerId);
      output = {
        ...output,
        claims: output.claims.filter((_, index) => index !== claimIndex),
      };

      problem = quoteProblem(output, batch);
    }
    // Validate full-answer digests and occurrence offsets before any checkpoint.
    buildCandidateInventory(output.claims, batch);
    args.signal?.throwIfAborted();
    await args.accounting.assertOwned();
    // A batch that lost claims is this run's best effort, not a settled
    // result: caching it would let a later run reuse the pruned set as if it
    // were complete. Raw proposals belong to the proved capture identity,
    // while the cache writer and rebuilt occurrences retain this processing
    // run's identity. This also lets another retry reuse batches first
    // produced by a retry.
    if (!cached && droppedAnswerIds.length === 0) {
      await args.batchCache?.put(lookupKey, {
        kind: 'validated_extraction_batch',
        version: 1,
        key: lookupKey,
        callId,
        output,
      });
    }

    completedBatches += 1;
    args.onProgress?.({
      batchIndex: start / batchSize,
      completedBatches,
      totalBatches: Math.ceil(args.answers.length / batchSize),
      cached: Boolean(cached),
    });
    return { kind: 'success', output, droppedAnswerIds };
  };

  const extracted: ExtractedClaim[] = [];
  const droppedByAnswer = new Map<string, number>();
  let extractedAnswers = 0;
  let extractionStopReason: NonNullable<
    GroundingCoverage['extractionStopReason']
  > = 'complete';

  let stopNewWork = false;

  for (let start = 0; start < args.answers.length;) {
    args.signal?.throwIfAborted();

    const waveSize = Math.min(
      concurrency,
      Math.floor((1000 - extracted.length) / maxClaimsPerBatch),
    );

    if (!waveSize) {
      // A prior provider gap must not become an aggregate-cacheable result.
      if (extractionStopReason === 'complete') {
        extractionStopReason = 'inventory_limit';
      }

      break;
    }

    const starts = Array.from(
      { length: waveSize },
      (_, index) => start + index * batchSize,
    ).filter((value) => value < args.answers.length);
    // Drain the entire wave even on an integrity failure: every dispatched call
    // settles its own accounting and independently validated batches may resume.
    const settled = await Promise.allSettled(starts.map(runBatch));
    const failed = settled.find((result) => result.status === 'rejected');

    if (failed?.status === 'rejected') {
      throw failed.reason;
    }

    for (const [index, settledResult] of settled.entries()) {
      if (settledResult.status !== 'fulfilled') {
        continue;
      }

      const batchStart = starts[index];

      if (batchStart === undefined) {
        throw new GroundingIntegrityError(
          `Extraction wave has no batch start for index: ${index}.`,
        );
      }

      let result = settledResult.value;

      if (result.kind === 'stop' && result.retryReservation && !stopNewWork) {
        result = await runBatch(batchStart);
      }

      if (result.kind === 'stop') {
        if (result.reason === 'budget_exhausted') {
          extractionStopReason = 'budget_exhausted';
          stopNewWork = true;
        } else if (!stopNewWork) {
          extractionStopReason = 'provider_unavailable';
        }
        // Keep later validated successes from this drained wave. An isolated
        // provider failure does not suppress independent, unattempted batches.
        continue;
      }

      extracted.push(...result.output.claims);

      for (const answerId of result.droppedAnswerIds) {
        droppedByAnswer.set(answerId, (droppedByAnswer.get(answerId) ?? 0) + 1);
      }

      extractedAnswers += Math.min(batchSize, args.answers.length - batchStart);
    }

    if (stopNewWork) {
      break;
    }

    start += starts.length * batchSize;
  }

  const droppedClaimsByAnswer = args.answers.flatMap((answer) => {
    const claims = droppedByAnswer.get(answer.id);
    return claims ? [{ answerId: answer.id, claims }] : [];
  });

  const droppedClaims = droppedClaimsByAnswer.reduce(
    (sum, entry) => sum + entry.claims,
    0,
  );

  return {
    candidates: buildCandidateInventory(extracted, args.answers),
    coverage: {
      suppliedAnswers: args.answers.length,
      extractionStopReason,
      extractedAnswers,
      truncatedAnswers: args.answers.filter(
        (answer) => answer.text.length > maxAnswerChars,
      ).length,
      ...(droppedClaims ? { droppedClaims, droppedClaimsByAnswer } : {}),
    },
  };
};
