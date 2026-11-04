import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalDigest } from '../bundle/json';
import { openRecorder } from '../bundle/recorder';
import { acquireWriterLock } from '../bundle/writer-lock';
import {
  authorBrand,
  materializeAuthorWorkdir,
  readAuthorOutput,
  readAuthorResearch,
  researchServerConfig,
  validateAuthorStage,
  type AuthorBrief,
} from '../codex-workflow/author';
import { runStage, type StageValue } from '../codex-workflow/stage';
import { mintRunId } from '../lib/run-id';
import { normalizeDomain } from '../analysis/scoring';
import { briefSchema } from '../workflow/schema';
import { allSurfaces, chatSurfaces } from '../schema';
import { hasErrorCode } from '../stores/fs-errors';
import {
  auditFileSchema,
  auditFileVersion,
  authorRecordFile,
  type AuditFile,
  type AuthorReference,
} from './audit-file';

// ============================================================================
// author (specs/aeo-open-source-cli-spec.md §4.1, §5): the explicit, paid
// alternative to writing audit.json by hand. One Codex session researches a
// brief through the host's metered tools and proposes a configuration; the
// host's verdict is the same the hosted author gets. The draft directory is
// a run of kind `author` with its own journal. The proposed audit.json
// names its author record by run id and digest, so a measurement run can
// bundle the record and the diff from proposal to final configuration.
// ============================================================================

const authorRecordSchema = z.looseObject({
  version: z.literal(1),
  runId: z.string(),
  brief: z.unknown(),
  proposed: z.unknown(),
  notes: z.unknown(),
  research: z.unknown(),
});

export type AuthorRecord = z.infer<typeof authorRecordSchema>;

/** The measurement fields of an audit file, which the digest and the diff
 * compare; the author reference and run policy are not measurement. */
const proposalOf = (file: AuditFile) => {
  const { author: _author, runPolicy: _runPolicy, ...measured } = file;

  return measured;
};

export const readBrief = async (file: string): Promise<AuthorBrief> => {
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    throw new Error(`Please check --brief: ${file} cannot be read.`, {
      cause: err,
    });
  });

  return briefSchema.parse(JSON.parse(text));
};

export type LocalAuthorResult = {
  ok: boolean;
  errors: string[];
  auditFile: string | undefined;
  research: Awaited<ReturnType<typeof readAuthorResearch>>['summary'];
};

/** runLocalAuthor runs the author session over a brief into `dir`. */
export const runLocalAuthor = async (args: {
  brief: AuthorBrief;
  dir: string;
  secrets: readonly string[];
  signal?: AbortSignal;
}): Promise<LocalAuthorResult> => {
  const { brief, dir } = args;
  const writer = await acquireWriterLock(dir, 'author');

  try {
    await materializeAuthorWorkdir({ dir, brief });

    const domain = normalizeDomain(brief.website).replace(/^www\./, '');
    const reportKey = `local-${domain.replace(/[^a-z0-9]+/g, '-')}`;
    const runId = mintRunId();
    const recorder = await openRecorder(dir, {
      origin: 'local',
      runId,
      // An author run measures nothing: its frozen input is the brief.
      measurementDigest: canonicalDigest({ kind: 'author', brief }),
      planDigest: canonicalDigest({ kind: 'author', brief }),
    });
    const verdict = async (value: StageValue) => {
      if (!('config' in value)) {
        throw new Error('The author verdict received another stage output.');
      }

      const result = await validateAuthorStage({
        dir,
        value,
        brief,
        reportKey,
        slug: reportKey,
        protectedClientHosts: [],
        secrets: [...args.secrets],
      });

      return result.fatal
        ? { errors: [result.fatal, ...result.errors], fatal: true }
        : { errors: result.errors };
    };
    const run = await runStage(
      {
        dir,
        brand: authorBrand(brief),
        answers: [],
        timeoutMs: 30 * 60_000,
        research: await researchServerConfig(dir),
        verdict,
        recorder,
        signal: args.signal,
      },
      'author',
    );
    const research = (await readAuthorResearch(dir)).summary;
    const output = await readAuthorOutput(dir);

    if (!run.ok || !output) {
      await recorder.record('run_failed', { errors: run.errors.slice(0, 5) });

      return { ok: false, errors: run.errors, auditFile: undefined, research };
    }

    const { config } = output;
    const proposed = auditFileSchema.parse({
      version: auditFileVersion,
      brand: config.brand,
      competitors: config.competitors,
      sections: config.sections,
      surfaces:
        config.surfaces.codingAgents === 'measure'
          ? [...allSurfaces]
          : [...chatSurfaces],
      agentProbes: config.agentProbes,
      geography: config.geography,
      language: config.language,
      moneyPages: config.moneyPages,
      productBrief: config.productBrief,
    });
    const author: AuthorReference = {
      runId,
      proposedDigest: canonicalDigest(proposalOf(proposed)),
      record: authorRecordFile,
    };
    const record: AuthorRecord = {
      version: 1,
      runId,
      brief,
      proposed: proposalOf(proposed),
      notes: output.notes,
      research,
    };
    const auditFile = path.join(dir, 'audit.json');

    await writeFile(
      path.join(dir, authorRecordFile),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    await writeFile(
      auditFile,
      `${JSON.stringify({ ...proposed, author }, null, 2)}\n`,
    );
    await recorder.record('run_completed', { auditFile: 'audit.json' });

    return { ok: true, errors: [], auditFile, research };
  } finally {
    await writer.release();
  }
};

export type AuthorEvidence =
  | { kind: 'manual' }
  | { kind: 'record_missing'; reference: AuthorReference }
  | {
      kind: 'authored';
      reference: AuthorReference;
      record: AuthorRecord;
      /** Changed measurement fields, proposed to final. */
      diff: { path: string; from: unknown; to: unknown }[];
      /** The final configuration is the proposal unedited. */
      unedited: boolean;
    };

const diffValues = (
  from: unknown,
  to: unknown,
  at = '$',
): { path: string; from: unknown; to: unknown }[] => {
  if (canonicalDigest(from ?? null) === canonicalDigest(to ?? null)) {
    return [];
  }

  const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  };

  if (isRecord(from) && isRecord(to)) {
    const keys = [
      ...new Set([...Object.keys(from), ...Object.keys(to)]),
    ].sort();

    return keys.flatMap((key) =>
      diffValues(from[key], to[key], `${at}.${key}`),
    );
  }

  if (Array.isArray(from) && Array.isArray(to) && from.length === to.length) {
    return from.flatMap((item, index) =>
      diffValues(item, to[index], `${at}[${index}]`),
    );
  }

  return [{ path: at, from: from ?? null, to: to ?? null }];
};

/**
 * readAuthorEvidence reads what a measurement run bundles about how its
 * configuration came to be: nothing for a manual config, the author record
 * and the diff for an authored one. Only the diff is known, never the
 * editing history between proposal and run.
 */
export const readAuthorEvidence = async (
  configFile: string,
  file: AuditFile,
): Promise<AuthorEvidence> => {
  if (!file.author) {
    return { kind: 'manual' };
  }

  const reference = file.author;
  const text = await readFile(
    path.join(path.dirname(configFile), reference.record),
    'utf8',
  ).catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });
  const record =
    text === undefined
      ? undefined
      : authorRecordSchema.safeParse(JSON.parse(text));

  if (
    !record?.success ||
    record.data.runId !== reference.runId ||
    canonicalDigest(record.data.proposed) !== reference.proposedDigest
  ) {
    return { kind: 'record_missing', reference };
  }

  const diff = diffValues(record.data.proposed, proposalOf(file));

  return {
    kind: 'authored',
    reference,
    record: record.data,
    diff,
    unedited: diff.length === 0,
  };
};
