import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../stores/fs-errors';
import { bundlePaths } from './contracts';
import { readFinalizedRevisions } from './export';
import { bundlePathError } from './paths';
import {
  archiveLimits,
  BundleRefusedError,
  readArchive,
  type ArchiveLimits,
} from './zip';

// ============================================================================
// Where `verify` reads a bundle from (specs/aeo-open-source-cli-spec.md §4.3,
// §8.2): an .aeo.zip archive, a finalized bundle directory, or a run
// directory, whose latest finalized revision is the one checked. Every form
// becomes the same in-memory file map; nothing is extracted to disk and
// nothing bundled is ever executed.
// ============================================================================

export type BundleSource = {
  files: Map<string, Buffer>;
  /** What was read, for the report: the archive, or the revision dir. */
  description: string;
};

const walkBundleDirectory = async (
  root: string,
  limits: ArchiveLimits,
): Promise<Map<string, Buffer>> => {
  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        throw new BundleRefusedError(
          'archive_entry_type',
          `${file} is a symbolic link.`,
        );
      }

      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }

      const pathError = bundlePathError(file);

      if (pathError) {
        throw new BundleRefusedError(
          'archive_entry_path',
          `${file} is refused: ${pathError}.`,
        );
      }

      const stats = await lstat(path.join(root, file));

      totalBytes += stats.size;

      if (
        files.size >= limits.maxEntries ||
        stats.size > limits.maxEntryBytes ||
        totalBytes > limits.maxTotalBytes
      ) {
        throw new BundleRefusedError(
          'archive_too_large',
          `${file} exceeds the bundle size limits.`,
        );
      }

      files.set(file, await readFile(path.join(root, file)));
    }
  };

  await walk('');

  return files;
};

/** readBundleSource reads the bundle at a path, refusing what it cannot
 * read safely. */
export const readBundleSource = async (
  target: string,
  limits: ArchiveLimits = archiveLimits,
): Promise<BundleSource> => {
  const resolved = path.resolve(target);
  const stats = await lstat(resolved).catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      throw new BundleRefusedError('not_found', `${resolved} does not exist.`);
    }

    throw err;
  });

  if (stats.isSymbolicLink()) {
    throw new BundleRefusedError(
      'archive_entry_type',
      `${resolved} is a symbolic link.`,
    );
  }

  if (stats.isFile()) {
    // Compressed bytes cannot exceed the expanded limit for a valid bundle.
    if (stats.size > limits.maxTotalBytes) {
      throw new BundleRefusedError(
        'archive_too_large',
        `${resolved} is larger than the bundle size limit.`,
      );
    }

    return {
      files: readArchive(await readFile(resolved), limits),
      description: resolved,
    };
  }

  const hasManifest = await lstat(
    path.join(resolved, bundlePaths.manifest),
  ).then(
    () => true,
    () => false,
  );

  if (hasManifest) {
    return {
      files: await walkBundleDirectory(resolved, limits),
      description: resolved,
    };
  }

  const latest = (await readFinalizedRevisions(resolved)).at(-1);

  if (!latest) {
    throw new BundleRefusedError(
      'no_finalized_revision',
      `${resolved} has no finalized revision. Please export it first (literally-aeo export ${target}).`,
    );
  }

  // The whole directory, not the manifest's inventory: an uninventoried
  // file is something verification must see.
  return {
    files: await walkBundleDirectory(latest.dir, limits),
    description: `${latest.dir} (latest finalized revision ${latest.manifest.revision.id})`,
  };
};
