import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from '../codex-workflow/pending';

// ============================================================================
// What a local run keeps about its own configuration
// (specs/aeo-open-source-cli-spec.md §5): the exact audit.json it ran from,
// and how that configuration came to be, written before any paid work and
// read by the exporter into inputs/audit.json and inputs/author/.
// ============================================================================

export const auditCopyFile = 'AUDIT.json';
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

/** recordRunConfiguration writes the run's audit.json and author evidence
 * into its directory, replacing what an earlier invocation wrote. */
export const recordRunConfiguration = async ({
  dir,
  configFile,
  evidence,
}: {
  dir: string;
  configFile: string;
  evidence: RecordedAuthorEvidence;
}): Promise<void> => {
  await writeFileAtomically(
    path.join(dir, auditCopyFile),
    await readFile(configFile, 'utf8'),
  );
  await writeFileAtomically(
    path.join(dir, authorEvidenceFile),
    JSON.stringify(authorEvidenceSchema.parse(evidence), null, 2),
  );
};
