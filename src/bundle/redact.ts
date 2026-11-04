import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  bundleManifestSchema,
  bundlePaths,
  digestManifest,
  type BundleManifest,
} from './contracts';
import { canonicalDigest, encodeBundleJson, sha256Hex } from './json';

// ============================================================================
// Redacted derivatives (specs/aeo-open-source-cli-spec.md §9). Withholding
// is declarative: paths and path prefixes with a reason, never code. The
// derivative names the full revision it came from by id and digest only
// (carrying it would undo the redaction), lists every withheld file, and
// keeps the withheld content's digest only when the operator says that is
// safe: a digest of short content invites guessing. The original revision
// stays local and unchanged.
// ============================================================================

export const redactionsSchema = z
  .object({
    version: z.literal(1),
    // A digest lets a recipient confirm a guess about withheld content.
    keepDigests: z.boolean().default(false),
    withhold: z
      .array(
        z
          .object({
            // A bundle path, or a prefix ending in '/' (objects/sha256/).
            path: z.string().min(1),
            reason: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type Redactions = z.infer<typeof redactionsSchema>;

export const readRedactions = async (file: string): Promise<Redactions> => {
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    throw new Error(`Please check --redact: ${file} cannot be read.`, {
      cause: err,
    });
  });

  return redactionsSchema.parse(JSON.parse(text));
};

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A revision id derived from what the derivative is: the same redaction
 * of the same revision is the same derivative, byte for byte. */
const derivedRevisionId = (seed: string): string => {
  const digest = Buffer.from(sha256Hex(seed), 'hex');

  return Array.from(digest.subarray(0, 26), (byte) =>
    crockford.charAt(byte % 32),
  ).join('');
};

/**
 * redactBundle derives a redacted bundle from a full revision's files. The
 * manifest can never be withheld: it is what states the redaction.
 */
export const redactBundle = (
  files: ReadonlyMap<string, Buffer>,
  manifest: BundleManifest,
  redactions: Redactions,
): Map<string, Buffer> => {
  const matches = (file: string) =>
    redactions.withhold.find((rule) =>
      rule.path.endsWith('/') ? file.startsWith(rule.path) : file === rule.path,
    );
  const kept = manifest.files.filter((entry) => !matches(entry.path));
  const withheld = manifest.files.flatMap((entry) => {
    const rule = matches(entry.path);

    return rule
      ? [
          {
            path: entry.path,
            bytes: redactions.keepDigests ? entry.bytes : null,
            sha256: redactions.keepDigests ? entry.sha256 : null,
            reason: rule.reason,
          },
        ]
      : [];
  });

  if (withheld.length === 0) {
    throw new Error(
      'The redaction withholds nothing: no rule matches a file of the bundle.',
    );
  }

  const { bundleDigest: _bundleDigest, ...full } = manifest;
  const unsigned: Omit<BundleManifest, 'bundleDigest'> = {
    ...full,
    revision: {
      id: derivedRevisionId(
        `${manifest.bundleDigest}:${canonicalDigest(redactions)}`,
      ),
      finalizedAt: manifest.revision.finalizedAt,
      predecessor: {
        id: manifest.revision.id,
        bundleDigest: manifest.bundleDigest,
      },
    },
    files: kept,
    redactions: withheld,
  };
  const derived = bundleManifestSchema.parse({
    ...unsigned,
    bundleDigest: digestManifest(unsigned),
  });
  const output = new Map<string, Buffer>([
    [bundlePaths.manifest, encodeBundleJson(derived)],
  ]);

  for (const entry of kept) {
    const bytes = files.get(entry.path);

    if (bytes === undefined) {
      throw new Error(`The revision lacks ${entry.path}.`);
    }

    output.set(entry.path, bytes);
  }

  return output;
};
