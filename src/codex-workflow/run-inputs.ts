import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { captureArtifactSchema } from '../harness/report/artifacts';
import {
  aeoAuditConfigSchema,
  aeoSurfaceSchema,
  runRequestSchema,
} from '../schema';
import { hasErrorCode } from '../stores/fs-errors';
import type { CapturedUnitRecord } from '../stores/ports';
import type { RunSource } from './run-source';

// ============================================================================
// INPUTS.json: the exact inputs a work directory was prepared from, written
// by the host on every prepare (specs/aeo-open-source-cli-spec.md §5, §8).
// The work directory otherwise holds only what the stages read (a reduced
// CONFIG.json, answer files); the bundle exporter needs the full config, the
// capture artifact and the captured records themselves to let a verifier
// recompute the report offline. Never read by a Codex stage.
// ============================================================================

export const runInputsFile = 'INPUTS.json';

// The probe's own fields vary by surface; the aggregate step reads text,
// modelName and runIndex, and keeps the rest as the capture recorded it.
const capturedRecordSchema = z.looseObject({
  status: z.literal('captured'),
  sectionKey: z.string().min(1),
  promptId: z.string().min(1),
  promptText: z.string(),
  surface: aeoSurfaceSchema,
  runIndex: z.number().int().positive(),
  capturedAt: z.string(),
  probe: z.looseObject({
    modelName: z.string(),
    runIndex: z.number().int(),
    text: z.string(),
  }),
});

const isCapturedRecord = (value: unknown): value is CapturedUnitRecord => {
  return capturedRecordSchema.safeParse(value).success;
};

export const capturedRecordsSchema = z.array(
  z.custom<CapturedUnitRecord>(isCapturedRecord, 'Invalid captured record.'),
);

// Batch placement is hosted integration metadata, not a run input.
const runPolicySchema = runRequestSchema.omit({
  batchJobId: true,
  batchAttempt: true,
});

export const runInputsSchema = z
  .object({
    version: z.literal(1),
    reportKey: z.string().min(1),
    runId: z.string().min(1),
    config: aeoAuditConfigSchema,
    request: runPolicySchema,
    surfaces: z.array(aeoSurfaceSchema),
    capture: captureArtifactSchema,
    captured: capturedRecordsSchema,
  })
  .strict();

export type RunInputs = z.infer<typeof runInputsSchema>;

export const writeRunInputs = async (
  dir: string,
  source: RunSource,
): Promise<void> => {
  const {
    batchJobId: _batchJobId,
    batchAttempt: _batchAttempt,
    ...request
  } = source.request;

  const inputs: RunInputs = {
    version: 1,
    reportKey: source.reportKey,
    runId: source.request.runId,
    config: source.config,
    request,
    surfaces: [...source.surfaces],
    capture: source.capture,
    captured: [...source.captured],
  };

  await writeFile(path.join(dir, runInputsFile), JSON.stringify(inputs));
};

/** readRunInputs reads INPUTS.json; undefined when the directory was
 * prepared before the file existed. */
export const readRunInputs = async (
  dir: string,
): Promise<RunInputs | undefined> => {
  const text = await readFile(path.join(dir, runInputsFile), 'utf8').catch(
    (err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) {
        return undefined;
      }

      throw err;
    },
  );

  if (text === undefined) {
    return undefined;
  }

  const inputs = runInputsSchema.parse(JSON.parse(text));

  return inputs;
};
