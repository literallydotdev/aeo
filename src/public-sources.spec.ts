import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// Everything in this repository is published
// (specs/aeo-claude-operator-spec.md §4.1, §5): the hosted service's model
// profile, its IDs, its routes and the reasons for them belong to the hosted
// platform, never here. The replay fixture is a recording of real answers,
// which may name any product, so it is the one directory not read.
// ============================================================================

const root = path.resolve(import.meta.dirname, '..');
const readDirectories = ['src', 'docs', 'scripts', '.claude', '.agents'];
const readFiles = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'package.json'];
const skipped = [path.join('src', '__fixtures__', 'replay'), 'node_modules'];

// Spelled in parts so this file does not match itself.
const hostedDetails: readonly RegExp[] = [
  new RegExp(['deep', 'seek'].join(''), 'i'),
  new RegExp(['\\bglm', '-?5'].join(''), 'i'),
  new RegExp(['\\bzai', '/'].join('')),
  new RegExp(
    ['fire', 'works|deep', 'infra|base', 'ten|friend', 'li'].join(''),
    'i',
  ),
  new RegExp(['codexRunner', 'Profile'].join('')),
  new RegExp(['\\b(?:opus|astra|glm)-(?:grounding|har', 'ness)-v\\d'].join('')),
];

const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(path.join(root, dir), {
    withFileTypes: true,
  }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(dir, entry.name);

      if (skipped.some((skip) => relative.startsWith(skip))) {
        return [];
      }

      return entry.isDirectory() ? filesUnder(relative) : [relative];
    }),
  );

  return nested.flat();
};

describe('public sources', () => {
  it("should NOT name the hosted service's model profile, its routes or its rationale", async () => {
    const files = [
      ...readFiles,
      ...(await Promise.all(readDirectories.map(filesUnder))).flat(),
    ];
    const found: string[] = [];

    // A guard against reading nothing: the engine has hundreds of files.
    expect(files.length).toBeGreaterThan(200);

    for (const file of files) {
      const text = await readFile(path.join(root, file), 'utf8').catch(
        () => '',
      );

      for (const pattern of hostedDetails) {
        if (pattern.test(text)) {
          found.push(`${file}: ${pattern.source}`);
        }
      }
    }

    expect(found).toEqual([]);
  });
});
