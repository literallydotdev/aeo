import { z } from 'zod';
import { progressSlotKey } from './progress-slot-key';
import { allSurfaces } from './surfaces';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const runId = z.string().regex(/^[a-zA-Z0-9_-]{1,180}$/);
const instant = z.iso.datetime();
export const questionSetNameSchema = z.string().trim().min(1).max(120);
const warning = z.enum([
  'invalid_capture_manifest',
  'historical_capture_metadata_unknown',
  'artifact_identity_mismatch',
  'plan_config_mismatch',
  'duplicate_planned_slots',
  'matrix_question_missing',
  'historical_run_index_unknown',
  'matrix_plan_mismatch',
  'collection_metadata_unknown',
  'includes_reused_captures',
  'reused_measurement',
  'analysis_replay',
]);

const progressSlotSchema = z
  .object({
    sectionKey: z.string().min(1).max(180),
    questionKey: digest,
    surface: z.enum(allSurfaces),
    runIndex: z.number().int().positive(),
    captured: z.boolean(),
    analyzed: z.boolean(),
    citationObserved: z.boolean(),
    captureId: digest.nullable(),
    mentioned: z.boolean(),
    cited: z.boolean(),
    requestedModel: z.string().min(1).max(256).nullable(),
    cliVersion: z.string().min(1).max(256).nullable(),
    collectionMethodDigest: digest.nullable(),
    collectionMetadataKnown: z.boolean(),
  })
  .strict()
  .superRefine((slot, context) => {
    if (
      (!slot.captured &&
        (slot.analyzed || slot.citationObserved || slot.captureId !== null)) ||
      (slot.mentioned && !slot.analyzed) ||
      (slot.cited && !slot.citationObserved)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Progress outcomes require their captured and analyzed evidence',
      });
    }

    if (
      slot.collectionMetadataKnown !== (slot.collectionMethodDigest !== null) ||
      (!slot.collectionMetadataKnown &&
        (slot.requestedModel !== null || slot.cliVersion !== null))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Progress collection metadata identity is inconsistent',
      });
    }
  });

/** This schema is the one persisted/public shape. Client code imports its
 * inferred types only; Zod and private input validation remain on the server. */
export const progressMeasurementSchema = z
  .object({
    version: z.literal(1),
    runId,
    // Presentation only, and only for consumers before 0.5.0, which label
    // their question-set selector with it. Stored history keeps it.
    questionSetName: questionSetNameSchema.optional(),
    publishedAt: instant.nullable(),
    captureWindow: z
      .object({ start: instant.nullable(), end: instant.nullable() })
      .strict(),
    measurementId: digest.nullable(),
    state: z.enum([
      'independent',
      'mixed',
      'reused',
      'derived',
      'legacy',
      'invalid',
    ]),
    warnings: z.array(warning).max(50),
    reusedCaptures: z.number().int().nonnegative(),
    brandIdentity: digest,
    geography: z.string().min(1).max(100),
    language: z.string().min(1).max(100),
    analyzer: z
      .object({
        version: z.number().int().positive().nullable(),
        model: z.string().min(1).max(256).nullable(),
      })
      .strict(),
    slots: z.array(progressSlotSchema).max(10000),
  })
  .strict()
  .superRefine((point, context) => {
    const { start, end } = point.captureWindow;

    if (
      (start === null) !== (end === null) ||
      (start !== null && end !== null && Date.parse(start) > Date.parse(end))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Progress capture window is inconsistent',
      });
    }

    const slots = point.slots.map(progressSlotKey);

    if (
      new Set(slots).size !== slots.length ||
      point.reusedCaptures > point.slots.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Progress planned slots or reuse count are inconsistent',
      });
    }
  });

export type ProgressSlot = z.infer<typeof progressSlotSchema>;
export type ProgressMeasurement = z.infer<typeof progressMeasurementSchema>;

/** Malformed persisted data is never downgraded to a missing legacy value.
 * Fail with a fixed diagnostic so rejected private values are not echoed. */
export const parseProgressMeasurement = (
  value: unknown,
  expectedRunId: string,
): ProgressMeasurement => {
  const parsed = progressMeasurementSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error('Invalid stored progress measurement');
  }

  if (parsed.data.runId !== expectedRunId) {
    throw new Error('Stored progress measurement belongs to another run');
  }

  return parsed.data;
};
