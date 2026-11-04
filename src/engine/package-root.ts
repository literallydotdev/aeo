import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const enginePackageName = 'literally-aeo';

const isEngineManifest = (file: string): boolean => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'));

    return (
      typeof manifest === 'object' &&
      manifest !== null &&
      'name' in manifest &&
      manifest.name === enginePackageName
    );
  } catch {
    return false;
  }
};

/**
 * enginePackageRoot is the directory of the engine's own package.json: the
 * repository root in a checkout, `node_modules/literally-aeo` in an install.
 * Found by walking up from this module, so it holds wherever the code was
 * bundled to (the CLI bundle, a library chunk, the source tree).
 */
export const enginePackageRoot = (): string => {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;

  for (;;) {
    if (isEngineManifest(path.join(dir, 'package.json'))) {
      return dir;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      throw new Error(
        `No ${enginePackageName} package.json above ${start}; the engine runs from its own package.`,
      );
    }

    dir = parent;
  }
};
