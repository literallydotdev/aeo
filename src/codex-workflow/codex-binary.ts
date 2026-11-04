import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getEnvironment } from '../lib/env';

// ============================================================================
// The Codex binary (specs/aeo-claude-operator-spec.md §4.3). The stage
// runtime is part of the method, so it is a pinned dependency of this
// package, never whatever `codex` happens to be on PATH. AEO_CODEX_BIN
// points elsewhere for a maintainer; every Codex session records which
// binary it ran, and its version when that is known without running it.
// ============================================================================

export type CodexBinarySource = 'dependency' | 'AEO_CODEX_BIN';

export type CodexBinary = {
  /** What to spawn, and the arguments that come before Codex's own. */
  command: string;
  prefixArgs: readonly string[];
  /** The file that was resolved, for doctor and the run record. */
  path: string;
  source: CodexBinarySource;
  /** The installed dependency's version, from its manifest; null for a
   * binary named from outside, whose version only running it can tell. */
  version: string | null;
};

const codexManifestSchema = z.object({
  version: z.string().min(1),
  bin: z.object({ codex: z.string().min(1) }),
});

/**
 * resolveCodexBinary returns the Codex the stages run: AEO_CODEX_BIN when
 * set, else this package's own dependency, started with the running Node so
 * no file mode or PATH entry is involved.
 */
export const resolveCodexBinary = (
  env: Record<string, string | undefined> = getEnvironment(),
): CodexBinary => {
  const override = env.AEO_CODEX_BIN;

  if (override !== undefined && override !== '') {
    return codexBinaryAt(override);
  }

  const require = createRequire(import.meta.url);
  const manifestFile = require.resolve('@openai/codex/package.json');
  const manifest = codexManifestSchema.parse(
    JSON.parse(readFileSync(manifestFile, 'utf8')),
  );
  const script = path.join(path.dirname(manifestFile), manifest.bin.codex);

  const binary: CodexBinary = {
    command: process.execPath,
    prefixArgs: [script],
    path: script,
    source: 'dependency',
    version: manifest.version,
  };

  return binary;
};

/** codexBinaryAt names a Codex executable directly, for a host or a test
 * that supplies its own, as AEO_CODEX_BIN does. */
export const codexBinaryAt = (command: string): CodexBinary => {
  return {
    command,
    prefixArgs: [],
    path: command,
    source: 'AEO_CODEX_BIN',
    version: null,
  };
};

/** codexArgs puts the binary's own prefix in front of Codex's arguments. */
export const codexArgs = (
  binary: CodexBinary,
  args: readonly string[],
): string[] => {
  return [...binary.prefixArgs, ...args];
};

/** The version the binary reports (`codex-cli 0.150.1`), or null when it
 * cannot be started. */
export const codexBinaryVersion = async (
  binary: CodexBinary = resolveCodexBinary(),
): Promise<string | null> => {
  try {
    const { stdout } = await promisify(execFile)(
      binary.command,
      codexArgs(binary, ['--version']),
      { timeout: 15_000 },
    );
    const [firstLine] = stdout.trim().split('\n');

    return firstLine === undefined || firstLine === '' ? null : firstLine;
  } catch {
    return null;
  }
};
