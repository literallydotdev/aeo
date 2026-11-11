import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from '../codex-workflow/pending';
import { isRecord } from '../lib/type-guards';
import type { ReasoningEffort } from '../models/profiles';

// ============================================================================
// What a local run keeps about its own configuration
// (specs/aeo-open-source-cli-spec.md §5): the exact audit.json it ran from,
// and how that configuration came to be, written before any paid work and
// read by the exporter into inputs/audit.json and inputs/author/.
// ============================================================================

export const auditCopyFile = 'AUDIT.json';
/** Inside a run directory: the probe bank, the analysis cache, the report
 * store, and what the run froze before its first paid call (budget, method,
 * bindings). */
export const bankDir = 'BANK';
export const authorEvidenceFile = 'AUTHOR-EVIDENCE.json';

const referenceSchema = z.looseObject({
  runId: z.string(),
  proposedDigest: z.string(),
});

export const authorEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('record_missing'), reference: referenceSchema }),
  z.object({
    kind: z.literal('authored'),
    reference: referenceSchema,
    record: z.unknown(),
    diff: z.array(
      z.object({ path: z.string(), from: z.unknown(), to: z.unknown() }),
    ),
    unedited: z.boolean(),
  }),
]);

export type RecordedAuthorEvidence = z.infer<typeof authorEvidenceSchema>;

/** readRecordedAuthorEvidence reads what a run recorded about how its
 * configuration came to be; a run from before the record says manual. */
export const readRecordedAuthorEvidence = async (
  dir: string,
): Promise<RecordedAuthorEvidence | undefined> => {
  const text = await readFile(path.join(dir, authorEvidenceFile), 'utf8').catch(
    () => undefined,
  );

  return text === undefined
    ? undefined
    : authorEvidenceSchema.parse(JSON.parse(text));
};

/** The report model a command names outside audit.json. */
export type ModelOverride = { model: string; modelEffort?: ReasoningEffort };

/** recordRunConfiguration writes the run's audit.json and author evidence
 * into its directory, replacing what an earlier invocation wrote. */
/** The operator's configuration with the model the run actually used,
 * asked as the run asked it: another model never inherits the effort the
 * file names for its own. */
const configWithModel = (
  text: string,
  { model, modelEffort }: ModelOverride,
): string => {
  const config: unknown = JSON.parse(text);

  if (!isRecord(config)) {
    throw new Error('The configuration to record is not a JSON object.');
  }

  const { modelEffort: _fileEffort, ...rest } = config;

  return `${JSON.stringify(
    { ...rest, model, ...(modelEffort !== undefined && { modelEffort }) },
    null,
    2,
  )}\n`;
};

export const recordRunConfiguration = async ({
  dir,
  configFile,
  evidence,
  model,
}: {
  dir: string;
  configFile: string;
  evidence: RecordedAuthorEvidence;
  /** A model named outside the file (`rejudge --model`, with its
   * `--effort`): the recorded configuration is the one the run ran with,
   * not the file's. */
  model?: ModelOverride;
}): Promise<void> => {
  const text = await readFile(configFile, 'utf8');

  await writeFileAtomically(
    path.join(dir, auditCopyFile),
    model === undefined ? text : configWithModel(text, model),
  );
  await writeFileAtomically(
    path.join(dir, authorEvidenceFile),
    JSON.stringify(authorEvidenceSchema.parse(evidence), null, 2),
  );
};
