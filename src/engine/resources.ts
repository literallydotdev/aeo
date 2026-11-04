import { access } from 'node:fs/promises';
import path from 'node:path';
import { enginePackageRoot } from './package-root';

// ============================================================================
// The engine's own files (specs/aeo-open-source-cli-spec.md §4.1): the copy
// and author rules, the banlist, the neutral editorial context and the
// operator guide. A packed install carries them in resources/; a checkout
// reads them in place under src/. Never the caller's working directory, and
// never a publisher's private editorial files unless AEO_EDITORIAL_DIR names
// them.
// ============================================================================

export type EngineResources = {
  /** The package root: what the workflow resolves its rule files against. */
  root: string;
  author: string;
  editorial: string;
  /** The operator guide `literally-aeo guide` prints. */
  guide: string;
};

const exists = async (file: string) => {
  return access(file).then(
    () => true,
    () => false,
  );
};

/** engineResources finds the resources of the running engine. */
export const engineResources = async (): Promise<EngineResources> => {
  const root = enginePackageRoot();
  const packed = path.join(root, 'resources');

  if (await exists(path.join(packed, 'author', 'COPY_RULES.md'))) {
    return {
      root,
      author: path.join(packed, 'author'),
      editorial: path.join(packed, 'editorial'),
      guide: path.join(packed, 'guide', 'OPERATOR.md'),
    };
  }

  return {
    root,
    author: path.join(root, 'src', 'author'),
    editorial: path.join(root, 'src', 'engine', 'editorial'),
    guide: path.join(root, 'src', 'engine', 'guide', 'OPERATOR.md'),
  };
};
