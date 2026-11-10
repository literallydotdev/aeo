import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { premiseVerifierPromptVersion } from '../agents/copy-validation';
import { factCatalogVersion } from '../agents/facts';
import { calculationVersion, toolVersion } from '../bundle/contracts';
import { writeFileAtomically } from '../codex-workflow/pending';
import { stageVersions } from '../codex-workflow/schemas';
import { canonicalJson } from '../lib/canonical-json';
import { hasErrorCode } from '../stores/fs-errors';

// ============================================================================
// A run directory keeps its method (specs/aeo-method-release-spec.md §3.1):
// the versions it is measured with are written to BANK/method.json before
// its first probe, and a resume under another method stops before any work.
// The aggregate runs on every workflow pass and the copy is checked against
// the fact catalog, so resuming under another method would silently pay
// again for perception, labels and copy, measured another way.
// ============================================================================

export const methodFile = 'method.json';

// The last release before run directories froze their method. It resumes
// every directory started before then, on the bindings it was captured
// with, and measures the way they were measured.
const lastReleaseBeforeMethodFreeze = '0.3.0';

const frozenMethodSchema = z
  .object({
    version: z.literal(1),
    calculationVersion: z.number().int().positive(),
    factCatalogVersion: z.number().int().positive(),
    stageVersions: z.record(z.string(), z.number().int().nonnegative()),
    premiseVerifierPromptVersion: z.number().int().positive(),
    // Recorded to name the release that can finish the directory; never
    // compared, so a release that keeps the method resumes it.
    toolVersion: z.string().min(1),
  })
  .strict();

export type FrozenMethod = z.infer<typeof frozenMethodSchema>;

/** A resume under another method, or of a directory from before methods
 * were frozen. Nothing has been dispatched. */
export class RunMethodChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunMethodChangedError';
  }
}

/** currentMethod is the method this engine measures with. */
export const currentMethod = (): FrozenMethod => {
  return {
    version: 1,
    calculationVersion,
    factCatalogVersion,
    stageVersions: { ...stageVersions },
    premiseVerifierPromptVersion,
    toolVersion,
  };
};

/** The parts of a method that change what a run measures. */
const measuredBy = ({ toolVersion: _tool, ...method }: FrozenMethod) => {
  return canonicalJson(method);
};

const finishOrRejudge = (dir: string, release: string) => {
  return `A run directory is finished by the method it started with: finish it with npx literally-aeo@${release} run --output ${dir}, which reuses every banked answer, or measure its captures under ${toolVersion} in a new directory with literally-aeo rejudge ${dir} --output <new-dir>.`;
};

/**
 * resolveRunMethod freezes a new run's method, and on a resume refuses a
 * directory frozen under another method or started before methods were
 * frozen (`startedBefore`), before anything else is written.
 */
export const resolveRunMethod = async (
  dir: string,
  bankPath: string,
  { startedBefore }: { startedBefore: boolean },
): Promise<FrozenMethod> => {
  const file = path.join(bankPath, methodFile);
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });
  const current = currentMethod();

  if (text === undefined) {
    if (startedBefore) {
      throw new RunMethodChangedError(
        `This run directory was started before literally-aeo 0.4.0, which measures with another method; it has no ${methodFile}. ${finishOrRejudge(dir, lastReleaseBeforeMethodFreeze)}`,
      );
    }

    await writeFileAtomically(file, `${JSON.stringify(current, null, 2)}\n`);

    return current;
  }

  let frozen: FrozenMethod;

  try {
    frozen = frozenMethodSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new RunMethodChangedError(
      `${file} is not a frozen method file (${error instanceof Error ? error.message.slice(0, 200) : String(error)}). Please restore it; a run never re-chooses how it measures.`,
    );
  }

  if (measuredBy(frozen) !== measuredBy(current)) {
    throw new RunMethodChangedError(
      `This run directory is measured with the method of literally-aeo ${frozen.toolVersion}; ${toolVersion} measures with another one. ${finishOrRejudge(dir, frozen.toolVersion)}`,
    );
  }

  return frozen;
};
