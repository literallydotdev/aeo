import type { z } from 'zod';
import { parseBundleJson } from './json';

// ============================================================================
// The vocabulary of offline verification (specs/aeo-open-source-cli-spec.md
// §10): independent checks with an outcome, a stable code, an explanation
// and the artifacts they are about.
// ============================================================================

export const CheckOutcome = {
  PASS: 'pass',
  FAIL: 'fail',
  UNSUPPORTED: 'unsupported',
  NOT_CHECKABLE: 'not_checkable',
  NOT_APPLICABLE: 'not_applicable',
} as const;

export type CheckOutcome = (typeof CheckOutcome)[keyof typeof CheckOutcome];

export type Check = {
  id: string;
  title: string;
  outcome: CheckOutcome;
  code: string;
  explanation: string;
  artifacts: string[];
};

export type Problem = { code: string; message: string; artifact?: string };

type CheckFromOptions = {
  id: string;
  title: string;
  problems: readonly Problem[];
  /** What a pass established. */
  pass: string;
};

/** checkFrom passes with no problems and fails on the first otherwise,
 * explaining every problem found. */
export const checkFrom = ({
  id,
  title,
  problems,
  pass,
}: CheckFromOptions): Check => {
  const first = problems[0];

  // Every problem is content the producer declared withheld: the check
  // cannot run, which is not the same as failing it (spec §9).
  if (
    first &&
    problems.every((problem) => problem.code.endsWith('_withheld'))
  ) {
    return {
      id,
      title,
      outcome: CheckOutcome.NOT_CHECKABLE,
      code: first.code,
      explanation: problems.map((problem) => problem.message).join(' '),
      artifacts: [],
    };
  }

  if (!first) {
    return {
      id,
      title,
      outcome: CheckOutcome.PASS,
      code: 'ok',
      explanation: pass,
      artifacts: [],
    };
  }

  const artifacts = problems.flatMap((problem) =>
    problem.artifact === undefined ? [] : [problem.artifact],
  );

  return {
    id,
    title,
    outcome: CheckOutcome.FAIL,
    code: first.code,
    explanation: problems.map((problem) => problem.message).join(' '),
    artifacts: [...new Set(artifacts)],
  };
};

/** A check whose outcome was decided without problems to list. */
export const decidedCheck = (check: Omit<Check, 'artifacts'>): Check => {
  return { ...check, artifacts: [] };
};

export const describeError = (err: unknown): string => {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
};

export type DocumentRead<T> = { value: T } | { problem: Problem };

/** createDocumentReader parses bundle documents; a missing or malformed
 * one is a problem of the check that needs it, never a crash. */
export const createDocumentReader = (
  files: ReadonlyMap<string, Buffer>,
  isWithheld: (file: string) => boolean = () => false,
) => {
  const read = <T>(file: string, schema: z.ZodType<T>): DocumentRead<T> => {
    const bytes = files.get(file);

    if (bytes === undefined && isWithheld(file)) {
      return {
        problem: {
          code: 'document_withheld',
          message: `${file} is withheld by the bundle's redaction.`,
          artifact: file,
        },
      };
    }

    if (bytes === undefined) {
      return {
        problem: {
          code: 'document_missing',
          message: `${file} is missing.`,
          artifact: file,
        },
      };
    }

    try {
      return { value: schema.parse(parseBundleJson(bytes.toString('utf8'))) };
    } catch (err) {
      return {
        problem: {
          code: 'document_invalid',
          message: `${file} is not valid: ${describeError(err)}`,
          artifact: file,
        },
      };
    }
  };

  return read;
};

export type DocumentReader = ReturnType<typeof createDocumentReader>;
