import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hasErrorCode } from '../stores/fs-errors';

// ============================================================================
// A derived run's lineage in its run directory (specs/aeo-open-source-cli-
// spec.md §5, §8): DERIVED.json names the finalized revision it derives
// from, and PREDECESSOR/<revisionId>/ holds that revision verbatim, which
// the exporter carries into the bundle under predecessors/.
// ============================================================================

export const derivedFile = 'DERIVED.json';
export const predecessorDir = 'PREDECESSOR';

export const derivedFromSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('rejudge'),
    runId: z.string().min(1),
    revisionId: z.string().regex(/^[0-9A-Z]{26}$/),
    bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type DerivedFrom = z.infer<typeof derivedFromSchema>;

/** readDerivedFrom reads a run directory's lineage, if it is derived. */
export const readDerivedFrom = async (
  dir: string,
): Promise<DerivedFrom | undefined> => {
  const text = await readFile(path.join(dir, derivedFile), 'utf8').catch(
    (err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) {
        return undefined;
      }

      throw err;
    },
  );

  return text === undefined
    ? undefined
    : derivedFromSchema.parse(JSON.parse(text));
};
