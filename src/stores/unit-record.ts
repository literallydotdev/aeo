import { z } from 'zod';
import { probeFailureKinds } from '../probes/failure';
import {
  aeoSurfaceSchema,
  isAgentSurface,
  retrievalLogSchema,
} from '../schema';
import type { UnitRecord } from './ports';

// ============================================================================
// A probe store row as it may have been written by any release (probe
// adapters spec §7, phase 3 item 6). Read rows are validated against it: a
// row that does not match stops the run before any dispatch. It is never read
// as missing, which would probe a paid unit again and then lose the new
// answer to the stored row's conflict on `put`.
//
// Every legacy shape is accepted: rows without `status` (before unit
// outcomes), without `runId`, `captureMetadata`, `retrieval` or a reported
// model. Validation never rewrites a row: the store keeps the bytes it read.
// ============================================================================

const unitFields = {
  sectionKey: z.string().min(1),
  promptId: z.string().min(1),
  promptText: z.string(),
  surface: aeoSurfaceSchema,
  runIndex: z.number().int().positive(),
  runId: z.string().min(1).optional(),
};

// Every field a release has banked on a probe: the chat result, then the
// coding agent's additions.
const probeSchema = z
  .object({
    promptId: z.string().min(1),
    promptText: z.string(),
    promptCategory: z.string(),
    modelName: aeoSurfaceSchema,
    runIndex: z.number().int().positive(),
    text: z.string(),
    retrieval: retrievalLogSchema.optional(),
    noOverview: z.literal(true).optional(),
    reportedModel: z.string().optional(),
    usedWebSearch: z.boolean().nullable().optional(),
    agentCliVersion: z.string().optional(),
    requestedModel: z.string().nullable().optional(),
  })
  .strict()
  .superRefine((probe, context) => {
    const agent = isAgentSurface(probe.modelName);

    if (
      agent &&
      (probe.usedWebSearch === undefined || !probe.agentCliVersion)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A coding-agent probe names its web-tool use and CLI version.',
      });
    }

    if (!agent && probe.agentCliVersion !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A chat probe carries no CLI version.',
      });
    }
  });

const captureMetadataSchema = z
  .object({
    requestedModel: z.string().nullable(),
    reportedModel: z.string().nullable(),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();

const capturedRowSchema = z
  .object({
    status: z.literal('captured').optional(),
    ...unitFields,
    capturedAt: z.iso.datetime(),
    probe: probeSchema,
    captureMetadata: captureMetadataSchema.optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      row.probe.modelName !== row.surface ||
      row.probe.promptId !== row.promptId ||
      row.probe.runIndex !== row.runIndex
    ) {
      context.addIssue({
        code: 'custom',
        message: "The probe's surface, prompt and run differ from the row's.",
      });
    }
  });

const failedRowSchema = z
  .object({
    status: z.literal('failed'),
    ...unitFields,
    failedAt: z.iso.datetime(),
    kind: z.enum(probeFailureKinds),
    attempts: z.number().int().nonnegative(),
    lastError: z.string(),
  })
  .strict();

/** A stored row that no release could have written. */
export class ProbeStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeStoreIntegrityError';
  }
}

const isRecordLike = (row: unknown): row is Record<string, unknown> => {
  return typeof row === 'object' && row !== null && !Array.isArray(row);
};

/**
 * parseUnitRecord validates a stored row and returns it as a unit record,
 * unchanged but for the `status` a row from before unit outcomes lacks.
 * `where` names the row in the error (a file line, a unit key).
 */
export const parseUnitRecord = (row: unknown, where: string): UnitRecord => {
  const failed = isRecordLike(row) && row.status === 'failed';
  const result = (failed ? failedRowSchema : capturedRowSchema).safeParse(row);

  if (!result.success || !isRecordLike(row)) {
    const issue = result.error?.issues[0];
    const field = issue?.path.join('.') ?? '';
    const reason = issue
      ? `${field === '' ? '' : `${field}: `}${issue.message}`
      : 'not an object';

    throw new ProbeStoreIntegrityError(
      `Probe store row ${where} is invalid (${reason}). Please repair or remove the row; the run stops rather than probe a banked unit again.`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Validated above; the row itself is kept so its stored bytes never change.
  const record = (
    failed || row.status === 'captured' ? row : { ...row, status: 'captured' }
  ) as UnitRecord;

  return record;
};
