import type { z } from 'zod';
import { isShortFormOf, normalizedBrandName } from '../analysis/name-forms';
import { normalizeDomain } from '../analysis/scoring';
import { reconcileProspectMentions } from '../analysis/search-analyzer';
import { locateVerbatimPassage } from '../analysis/verbatim';
import { finalCopyDraftSchemaForSections } from '../agents/copy-schema';
import type { AeoBrand } from '../schema';
import {
  stageSchemas,
  qualificationQuoteMaxLength,
  type AnalyzeOutput,
  type AuthorStageOutput,
  type QualifyOutput,
  type ReviewOutput,
  type StageName,
  type WriteOutput,
} from './schemas';
import type { AnswerFile } from './workdir';

// ============================================================================
// The host's judgment-free checks on what a stage produced
// (specs/aeo-codex-workflow-spec.md §4): shapes, completeness, quotes and
// the consistency rules the harness already had, per stage, plus how batch
// outputs merge into one stage output. Nothing here calls a model.
// ============================================================================

export type StageValue =
  | AnalyzeOutput
  | QualifyOutput
  | ReviewOutput
  | WriteOutput
  | AuthorStageOutput;

export type CheckScope = {
  brand: AeoBrand;
  /** The answers the output is judged against: a batch's files for a
   * batch, every file for the merged stage. */
  answers: readonly AnswerFile[];
  /** The configured section keys; absent, the answers' own sections. */
  sections?: readonly string[];
  /** Hosts the client owns besides its brand domain (a former brand, a
   * second site); an entry on one of them is the client, not an alternative. */
  ownedDomains?: readonly string[];
  /** Whether every answer must have a row. Off for a correction, which is
   * judged on row consistency alone: a degraded run has files without
   * rows, and that is not the correction's fault. */
  coverage: boolean;
};

export type Checked<T extends StageValue = StageValue> = {
  value: T;
  errors: string[];
};

/** A stage output after validation: the checked value, or only the schema's
 * errors when the output never had the stage's shape. */
export type Validated = Checked | { value?: undefined; errors: string[] };

type ParseResult<T> =
  { success: true; data: T } | { success: false; error: z.ZodError };

export type StageChecks<T extends StageValue = StageValue> = {
  parse: (scope: CheckScope, output: unknown) => ParseResult<T>;
  check: (scope: CheckScope, value: T) => Checked<T>;
  merge: (values: readonly T[]) => T;
};

const fileSet = (scope: CheckScope) => {
  return new Set(scope.answers.map((answer) => answer.file));
};

const correctionsOnKnownFiles = (
  scope: CheckScope,
  corrections: readonly { file: string }[],
): string[] => {
  const files = fileSet(scope);

  return corrections
    .filter((correction) => !files.has(correction.file))
    .map(
      (correction) =>
        `correction on ${correction.file}: not an answer file of this batch`,
    );
};

const analyze: StageChecks<AnalyzeOutput> = {
  parse: (_scope, output) => stageSchemas.analyze.safeParse(output),
  check(scope, value) {
    const errors: string[] = [];
    const files = fileSet(scope);
    const seen = new Set<string>();

    for (const row of value.rows) {
      if (!files.has(row.file)) {
        errors.push(`${row.file}: not an answer file of this batch`);
      }

      if (seen.has(row.file)) {
        errors.push(`${row.file}: judged twice`);
      }

      seen.add(row.file);
    }

    if (scope.coverage) {
      for (const file of files) {
        if (!seen.has(file)) {
          errors.push(`${file}: no row`);
        }
      }
    }

    // The two fields are one judgment: the prospect cannot be absent and
    // listed among the brands at once.
    const rows = value.rows.map((row) => {
      const reconciled = reconcileProspectMentions(
        {
          clientMentioned: row.prospectMentioned,
          allMentionedBrands: row.mentionedBrands,
        },
        scope.brand,
      );

      return { ...row, mentionedBrands: reconciled.allMentionedBrands };
    });

    return { value: { ...value, rows }, errors };
  },
  merge: (values) => ({ rows: values.flatMap((value) => value.rows) }),
};

/** Restore formatting only; changed words still fail the evidence check. */
export const restoreQualificationQuotes = (
  row: QualifyOutput['rows'][number],
  body: string,
): QualifyOutput['rows'][number] => {
  return {
    ...row,
    qualifiedCompetitors: row.qualifiedCompetitors.map((entry) => {
      const passage = locateVerbatimPassage(body, entry.quote.trim());

      return {
        ...entry,
        quote:
          passage !== null && passage.length <= qualificationQuoteMaxLength
            ? passage
            : entry.quote,
      };
    }),
  };
};

const qualify: StageChecks<QualifyOutput> = {
  parse: (_scope, output) => stageSchemas.qualify.safeParse(output),
  check(scope, value) {
    const errors: string[] = [];
    const files = fileSet(scope);
    const bodyOf = new Map(
      scope.answers.map((answer) => [answer.file, answer.body]),
    );
    const seenFiles = new Set<string>();
    const owned = new Set(
      [scope.brand.domain, ...(scope.ownedDomains ?? [])].map(normalizeDomain),
    );
    const brandNames = new Set(
      [scope.brand.name, ...scope.brand.aliases].map(normalizedBrandName),
    );
    // The client is never its own alternative: an entry on the brand's
    // domain, an owned host or under the brand's name or alias is dropped,
    // not refused, since the writer was asked to list what the answer named.
    const rows = value.rows.map((row) =>
      restoreQualificationQuotes(
        {
          ...row,
          qualifiedCompetitors: row.qualifiedCompetitors.filter(
            (entry) =>
              !(entry.domain && owned.has(normalizeDomain(entry.domain))) &&
              !brandNames.has(normalizedBrandName(entry.name)),
          ),
        },
        bodyOf.get(row.file) ?? '',
      ),
    );

    for (const row of rows) {
      const body = bodyOf.get(row.file);

      if (body === undefined) {
        errors.push(`${row.file}: not an answer file of this batch`);
        continue;
      }

      if (seenFiles.has(row.file)) {
        errors.push(`${row.file}: qualified twice`);
      }

      seenFiles.add(row.file);

      // One entry per alternative is one entry per product name: two
      // products of one vendor share a domain and are two alternatives
      // (Cloud Run and Cloud Functions; the first scrutiny pass caught the
      // domain key collapsing them).
      const seen = new Set<string>();

      for (const entry of row.qualifiedCompetitors) {
        const key = normalizedBrandName(entry.name);

        if (seen.has(key)) {
          errors.push(`${row.file}: ${entry.name} qualified twice`);
        }

        seen.add(key);

        if (!body.toLowerCase().includes(entry.quote.trim().toLowerCase())) {
          errors.push(
            `${row.file}: quote for ${entry.name} is not in the answer body: "${entry.quote.slice(0, 80)}"`,
          );
        }
      }
    }

    if (scope.coverage) {
      for (const file of files) {
        if (!seenFiles.has(file)) {
          errors.push(`${file}: no row`);
        }
      }
    }

    errors.push(...correctionsOnKnownFiles(scope, value.corrections));

    return { value: { ...value, rows }, errors };
  },
  merge: (values) => ({
    rows: canonicalizeQualifiedNames(values.flatMap((value) => value.rows)),
    corrections: values.flatMap((value) => value.corrections),
  }),
};

const review: StageChecks<ReviewOutput> = {
  parse: (_scope, output) => stageSchemas.review.safeParse(output),
  check(scope, value) {
    const errors = correctionsOnKnownFiles(scope, value.corrections);

    if (value.verdict === 'accepted' && value.unresolved.length) {
      errors.push('accepted with unresolved problems listed');
    }

    if (
      value.verdict === 'accepted' &&
      value.criteria.some((criterion) => criterion.outcome === 'fail')
    ) {
      errors.push('accepted with a failed criterion');
    }

    return { value, errors };
  },
  merge(values) {
    const criteria = new Map<string, 'pass' | 'fail'>();

    for (const value of values) {
      for (const criterion of value.criteria) {
        criteria.set(
          criterion.criterionId,
          criteria.get(criterion.criterionId) === 'fail'
            ? 'fail'
            : criterion.outcome,
        );
      }
    }

    return {
      verdict: values.every((value) => value.verdict === 'accepted')
        ? 'accepted'
        : 'needs_another_pass',
      criteria: [...criteria].map(([criterionId, outcome]) => ({
        criterionId,
        outcome,
      })),
      corrections: values.flatMap((value) => value.corrections),
      unresolved: values.flatMap((value) => value.unresolved),
    };
  },
};

const write: StageChecks<WriteOutput> = {
  // The draft must name every configured section: the keys come from the
  // answers the run judged. The section-keyed schema only narrows the base
  // one; its output is parsed again for the type, which keeps the sections
  // in the configured order the section-keyed parse gave them.
  parse: (scope, output) => {
    const sectioned = finalCopyDraftSchemaForSections(
      scope.sections ?? [
        ...new Set(scope.answers.map((answer) => answer.sectionKey)),
      ],
    ).safeParse(output);

    if (!sectioned.success) {
      return { success: false, error: sectioned.error };
    }

    return stageSchemas.write.safeParse(sectioned.data);
  },
  check: (_scope, value) => ({ value, errors: [] }),
  merge: (values) => onlyValue('write', values),
};

/** The one output of a stage that runs as a single session. */
const onlyValue = <T>(stage: StageName, values: readonly T[]): T => {
  const [value] = values;

  if (value === undefined) {
    throw new Error(`The ${stage} stage has no output to merge.`);
  }

  return value;
};

const author: StageChecks<AuthorStageOutput> = {
  // The structural check only; the config's own rules (identity, sources,
  // reachability) are the host's asynchronous verdict on the stage.
  parse: (_scope, output) => stageSchemas.author.safeParse(output),
  check: (_scope, value) => ({ value, errors: [] }),
  merge: (values) => onlyValue('author', values),
};

const validateWith = <T extends StageValue>(
  checks: StageChecks<T>,
  scope: CheckScope,
  output: unknown,
): Validated => {
  const parsed = checks.parse(scope, output);

  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (issue) =>
        `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );

    return { errors };
  }

  return checks.check(scope, parsed.data);
};

/** Schema, then the stage's own rules, over the answers in scope. */
export const validateStage = (
  scope: CheckScope,
  stage: StageName,
  output: unknown,
): Validated => {
  switch (stage) {
    case 'analyze':
      return validateWith(analyze, scope, output);
    case 'qualify':
      return validateWith(qualify, scope, output);
    case 'review':
      return validateWith(review, scope, output);
    case 'write':
      return validateWith(write, scope, output);
    case 'author':
      return validateWith(author, scope, output);
    default: {
      const unhandled: never = stage;

      throw new Error(`Unhandled stage: ${String(unhandled)}.`);
    }
  }
};

// The stage outputs share no tag; each has a key the others lack.
const isAnalyzeOutput = (value: StageValue): value is AnalyzeOutput => {
  return 'rows' in value && !('corrections' in value);
};

const isQualifyOutput = (value: StageValue): value is QualifyOutput => {
  return 'rows' in value && 'corrections' in value;
};

const isReviewOutput = (value: StageValue): value is ReviewOutput => {
  return 'verdict' in value;
};

const isWriteOutput = (value: StageValue): value is WriteOutput => {
  return 'hero' in value;
};

const isAuthorStageOutput = (value: StageValue): value is AuthorStageOutput => {
  return 'config' in value;
};

const requireStageValues = <T extends StageValue>(
  stage: StageName,
  values: readonly StageValue[],
  isStageValue: (value: StageValue) => value is T,
): T[] => {
  return values.map((value) => {
    if (!isStageValue(value)) {
      throw new Error(
        `A batch output of the ${stage} stage has another stage's shape.`,
      );
    }

    return value;
  });
};

/** Batch outputs as one stage output, in batch order. */
export const mergeBatches = (
  stage: StageName,
  values: readonly StageValue[],
): StageValue => {
  switch (stage) {
    case 'analyze':
      return analyze.merge(requireStageValues(stage, values, isAnalyzeOutput));
    case 'qualify':
      return qualify.merge(requireStageValues(stage, values, isQualifyOutput));
    case 'review':
      return review.merge(requireStageValues(stage, values, isReviewOutput));
    case 'write':
      return write.merge(requireStageValues(stage, values, isWriteOutput));
    case 'author':
      return author.merge(
        requireStageValues(stage, values, isAuthorStageOutput),
      );
    default: {
      const unhandled: never = stage;

      throw new Error(`Unhandled stage: ${String(unhandled)}.`);
    }
  }
};

/** One name per alternative across the whole section: batches never see
 * each other, so one wrote "Cloud Run" and another "Google Cloud Run"
 * (run C, 2026-09-13) and the counts split. */
export const canonicalizeQualifiedNames = (
  rows: QualifyOutput['rows'],
): QualifyOutput['rows'] => {
  // Every distinct name the section used, with the domains seen for it.
  const known = new Map<string, { name: string; domains: Set<string> }>();

  for (const row of rows) {
    for (const entry of row.qualifiedCompetitors) {
      const key = normalizedBrandName(entry.name);
      const seen = known.get(key) ?? {
        name: entry.name.trim(),
        domains: new Set<string>(),
      };

      if (entry.domain) {
        seen.domains.add(entry.domain);
      }

      known.set(key, seen);
    }
  }

  // An entry takes a full form only when exactly one exists whose domains
  // do not contradict the entry's own: "Edge Functions" next to both
  // Vercel's and Netlify's stays as written, unless its domain says which.
  const fullFormFor = (entry: { name: string; domain: string | null }) => {
    const candidates = [...known.values()].filter(
      (candidate) =>
        isShortFormOf(entry.name, candidate.name) &&
        (entry.domain === null ||
          candidate.domains.size === 0 ||
          candidate.domains.has(entry.domain)),
    );

    if (candidates.length !== 1) {
      return null;
    }

    const [full] = candidates;

    if (!full) {
      return null;
    }

    return {
      name: full.name,
      domain: entry.domain ?? [...full.domains][0] ?? null,
    };
  };

  return rows.map((row) => {
    const seen = new Set<string>();
    const qualifiedCompetitors: typeof row.qualifiedCompetitors = [];

    for (const entry of row.qualifiedCompetitors) {
      const full = fullFormFor(entry);
      const name = full?.name ?? entry.name;
      const key = normalizedBrandName(name);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      qualifiedCompetitors.push({
        ...entry,
        name,
        domain: full?.domain ?? entry.domain,
      });
    }

    return { ...row, qualifiedCompetitors };
  });
};
