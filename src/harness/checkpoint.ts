import { z } from 'zod';
import { artifactRefSchema, digestSchema } from './contracts';

// Checkpoints contain report work and conversation rollouts, never CLI
// configuration, credentials, databases, or arbitrary filesystem paths.
export const checkpointPathSchema = z
  .string()
  .max(300)
  .refine(
    (file) =>
      !file.split('/').some((part) => part === '.' || part === '..') &&
      /^(?:(?:OUT|REVIEW|PENDING|RESEARCH)\/[A-Za-z0-9_./-]+|JOURNAL\/(?:analyze|qualify|review|write|author)-\d+\.(?:md|session\.json|failures\.jsonl|refusals\.jsonl|research\.jsonl)|JOURNAL\/run\/(?:events\.jsonl|objects\/sha256\/[a-f0-9]{64})|\.codex-home\/sessions\/[A-Za-z0-9_./-]+\.jsonl|(?:METRICS|FACTS|SCORECARD|TECHNICAL)\.json)$/.test(
        file,
      ),
    'Unexpected checkpoint path',
  );

export const checkpointByteLimit = 512 * 1024 * 1024;
export const checkpointFileByteLimit = 128 * 1024 * 1024;
export const checkpointChunkBytes = 384 * 1024;

export const checkpointIndexSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().min(1).max(200),
    files: z.record(
      checkpointPathSchema,
      z
        .object({
          bytes: z.number().int().min(0).max(checkpointFileByteLimit),
          digest: digestSchema,
          chunks: z
            .array(
              artifactRefSchema.refine(
                (ref) => ref.kind === 'workflow_checkpoint_chunk',
              ),
            )
            .max(400),
        })
        .strict(),
    ),
  })
  .strict();

export const checkpointChunkSchema = z
  .object({
    encoding: z.literal('base64'),
    data: z
      .string()
      .max((checkpointChunkBytes * 4) / 3)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
