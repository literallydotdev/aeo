import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hasErrorCode } from '../stores/fs-errors';
import type { StageName } from './schemas';
import type { AnswerFile } from './workdir';

const trailEntrySchema = z.looseObject({
  by: z.string(),
  at: z.string(),
  outcome: z.string(),
  stage: z.string(),
  file: z.string(),
  field: z.string(),
  to: z.string(),
});

type TrailEntry = z.infer<typeof trailEntrySchema>;

// The audit trail is written by the host's applyCorrections; entries keep
// their written form, since refused ones are shown to the reviewer as is.
const isTrailEntry = (entry: unknown): entry is TrailEntry => {
  return trailEntrySchema.safeParse(entry).success;
};

const previousPassSchema = z.record(z.string(), z.unknown()).nullable();

const previousCorrectionsSchema = z.array(z.record(z.string(), z.unknown()));

const readUnlessMissing = async (
  read: (file: string) => Promise<string>,
  { file, fallback }: { file: string; fallback: string },
) => {
  try {
    return await read(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return fallback;
    }

    throw error;
  }
};

/** Supply the complete batch directly, without tool-output truncation or
 * repeated reads of shared rules. A resumed reviewer already has its evidence. */
export const batchInput = async (args: {
  dir: string;
  stage: Exclude<StageName, 'write'>;
  index: number;
  answers: readonly AnswerFile[];
  sharedFiles: readonly string[];
  continuation: boolean;
}): Promise<string> => {
  const { dir, stage, index } = args;
  const read = (file: string) => {
    return readFile(path.join(dir, file), 'utf8');
  };
  const inputFile = `OUT/${stage}/${index}.${stage === 'analyze' ? 'index' : 'rows'}.json`;
  const current: unknown = JSON.parse(await read(inputFile));
  // The previous pass is a host-written batch output, handed over as written:
  // a schema change reruns the batch, and its old output still informs it.
  let previous: Record<string, unknown> | null | undefined =
    stage === 'review'
      ? previousPassSchema.parse(
          JSON.parse(
            await readUnlessMissing(read, {
              file: `OUT/review/${index}.previous.json`,
              fallback: 'null',
            }),
          ),
        )
      : undefined;

  // A reviewer must see why a proposal was refused, without searching other
  // batches' journals. Only accepted proposals belong in its previous fixes.
  let hostFeedback: { instruction: string; corrections: unknown[] } | undefined;

  if (previous) {
    const trail = z
      .array(z.unknown())
      .parse(
        JSON.parse(
          await readUnlessMissing(read, {
            file: 'OUT/corrections.json',
            fallback: '[]',
          }),
        ),
      )
      .filter(isTrailEntry);

    const files = new Set(args.answers.map((answer) => answer.file));
    const own = trail.filter(
      (entry) => entry.by === 'review' && files.has(entry.file),
    );
    const latest = own.at(-1)?.at;
    const refused = own.filter(
      (entry) => entry.at === latest && entry.outcome.startsWith('refused:'),
    );

    if (refused.length) {
      previous = {
        ...previous,
        corrections: previousCorrectionsSchema
          .parse(previous.corrections)
          .filter(
            (correction) =>
              !refused.some(
                (entry) =>
                  entry.stage === correction.stage &&
                  entry.file === correction.file &&
                  entry.field === correction.field &&
                  entry.to === correction.to,
              ),
          ),
      };
      hostFeedback = {
        instruction:
          'These proposed corrections were not applied. Repair them against current rows. Use a nested field path for an individual property, or a complete array when replacing an array field.',
        corrections: refused,
      };
    }
  }

  const files: Record<string, unknown> = {};

  if (!args.continuation) {
    for (const file of [...args.sharedFiles, `SCHEMA/${stage}.json`]) {
      const content = await read(file);

      files[file] = file.endsWith('.json') ? JSON.parse(content) : content;
    }
  }

  return JSON.stringify({
    stage,
    batch: index,
    continuation: args.continuation,
    files,
    current,
    previous,
    ...(hostFeedback ? { hostFeedback } : {}),
    ...(!args.continuation ? { answers: args.answers } : {}),
  });
};
