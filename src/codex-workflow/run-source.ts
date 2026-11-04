import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ExecutionRecorder } from '../bundle/recorder';
import { runTechnicalChecks } from '../checks/run-checks';
import type { GroundingBundle } from '../grounding/schema';
import {
  technicalChecksArtifactSchema,
  type CaptureArtifact,
  type TechnicalChecksArtifact,
} from '../harness/report/artifacts';
import { mintRunId } from '../lib/run-id';
import type { RunPlan } from '../runner';
import type { AeoAuditConfig, AeoSurface, RunRequest } from '../schema';
import { hasErrorCode } from '../stores/fs-errors';
import type { CapturedUnitRecord, Stores } from '../stores/ports';
import { checkpointScope } from './checkpoint';
import { writeFileAtomically } from './pending';

// ============================================================================
// What every run source is made of, with no database behind it: the run's
// inputs, and the files a work directory keeps about its own run (its run
// id, its technical checks). The local engine's source is
// src/engine/local-run.ts; a hosted adapter builds its own from a database.
// ============================================================================

export type RunSource = {
  /** What names the work directory: the execution in the job, the report
   * key in the CLI. */
  id: string;
  reportKey: string;
  config: AeoAuditConfig;
  request: RunRequest;
  plan: RunPlan;
  surfaces: readonly AeoSurface[];
  capture: CaptureArtifact;
  captured: readonly CapturedUnitRecord[];
  /** The run's technical checks and grounding, when it has them; the
   * finish step reuses them rather than fetching the site again. */
  technical: TechnicalChecksArtifact | null;
  grounding: GroundingBundle | null;
  /** The report's stores: labels cache, analysis cache, the report write. */
  stores: Stores;
  close(): Promise<void>;
};

/** Technical capture belongs to this local run, like its banked answers.
 * Re-fetching on resume changes timestamps and invalidates finish and copy. */
export const localTechnicalChecks = async (
  config: AeoAuditConfig,
  dir?: string,
  recorder?: ExecutionRecorder,
): Promise<TechnicalChecksArtifact> => {
  if (!dir) {
    return { version: 1, ...(await runTechnicalChecks(config, recorder)) };
  }

  const scope = checkpointScope(config);
  const stored = await readTechnicalChecks(dir, scope);

  if (stored) {
    // Captured by an earlier attempt of this run; reuse names it.
    await recorder?.record(
      'artifact_reused',
      { artifact: 'technical_checks' },
      { output: JSON.stringify(stored) },
    );

    return stored;
  }

  const artifact = {
    version: 1 as const,
    ...(await runTechnicalChecks(config, recorder)),
  };

  await writeTechnicalChecks(dir, scope, artifact);

  return artifact;
};

const storedTechnicalChecksSchema = z.looseObject({
  configDigest: z.string().optional(),
  artifact: z.unknown().optional(),
});

/** TECHNICAL.json, the one shape every runner writes: the technical
 * artifact keyed by the config it was captured for, so a work directory
 * reused for another configuration never hands back stale checks. */
export const readTechnicalChecks = async (
  dir: string,
  configDigest: string,
): Promise<TechnicalChecksArtifact | null> => {
  const raw = await readFile(path.join(dir, 'TECHNICAL.json'), 'utf8').catch(
    (error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) {
        return null;
      }

      throw error;
    },
  );

  if (raw === null) {
    return null;
  }

  const stored = storedTechnicalChecksSchema.parse(JSON.parse(raw));

  return stored.configDigest === configDigest
    ? technicalChecksArtifactSchema.parse(stored.artifact)
    : null;
};

export const writeTechnicalChecks = async (
  dir: string,
  configDigest: string,
  artifact: TechnicalChecksArtifact,
): Promise<void> => {
  await writeFileAtomically(
    path.join(dir, 'TECHNICAL.json'),
    JSON.stringify({ configDigest, artifact }, null, 2),
  );
};

const storedRunIdSchema = z.looseObject({ runId: z.string() });

export const persistedRunId = async (dir: string): Promise<string> => {
  const file = path.join(dir, 'RUN.json');

  try {
    const stored = storedRunIdSchema.safeParse(
      JSON.parse(await readFile(file, 'utf8')),
    );

    if (stored.success && stored.data.runId) {
      return stored.data.runId;
    }
  } catch {
    // First use of this work directory.
  }

  const runId = mintRunId();

  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ runId }, null, 2));

  return runId;
};
