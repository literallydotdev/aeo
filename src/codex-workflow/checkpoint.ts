import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';
import { checkpointPathSchema } from '../harness/checkpoint';
import type { HarnessFence, HarnessStore } from '../harness/store';
import { contentHash } from '../stores/content-hash';
import { retryLineage } from '../workflow/lineage';
import { writeFileAtomically } from './pending';
import { workflowVersion } from './schemas';

/** Only settled outputs and isolated conversation rollouts are durable.
 * Inputs are reconstructed from the pinned run; credentials are never copied. */
export const checkpointFiles = async (
  dir: string,
  relative = '',
): Promise<string[]> => {
  const files: string[] = [];

  for (const entry of await readdir(path.join(dir, relative), {
    withFileTypes: true,
  }).catch(() => [])) {
    const file = path.posix.join(relative, entry.name);

    if (entry.isDirectory()) {
      if (
        relative ||
        ['OUT', 'REVIEW', 'PENDING', 'JOURNAL', '.codex-home'].includes(
          entry.name,
        )
      ) {
        files.push(...(await checkpointFiles(dir, file)));
      }
    } else if (
      entry.isFile() &&
      !file.endsWith('.tmp') &&
      checkpointPathSchema.safeParse(file).success
    ) {
      files.push(file);
    }
  }

  return files.sort();
};

/** What a checkpoint may be restored into: the same config under the same
 * workflow version. Per-batch input digests still decide what is reused. */
export const checkpointScope = (config: unknown): string => {
  return contentHash({ config, workflow: workflowVersion });
};

export const restoreCheckpoint = async (args: {
  sql: Sql;
  harness: HarnessStore;
  fence: HarnessFence;
  pipelineId: string | null;
  reportKey: string;
  scope: string;
  dir: string;
  log?: (line: string) => void;
}): Promise<(files?: readonly string[]) => Promise<void>> => {
  let saved = await args.harness.readCheckpoint(args.fence.executionId);

  if (!saved && args.pipelineId) {
    // A supported retry inherits only its own ancestry, never another
    // admission's analyses. Per-batch digests still check every input.
    const lineage = (await retryLineage(args.sql, args.pipelineId))
      .filter((attempt) => attempt.reportKey === args.reportKey)
      .map((attempt) => attempt.pipelineId);
    // Newest attempt first. Rows written before the checkpoint slot existed
    // lack the key; a slot that was never advanced holds null.
    const rows = await args.sql<{ executionId: string }[]>`
      SELECT e."executionId" FROM "AeoHarnessExecution" e
      WHERE e."pipelineId" = ANY(${lineage}::text[])
        AND e."executionId"<>${args.fence.executionId}
        AND jsonb_typeof(e.manifests->'checkpoint') = 'object'
      ORDER BY array_position(${lineage}::text[], e."pipelineId"), e."createdAt" DESC`;

    for (const row of rows) {
      const candidate = await args.harness.readCheckpoint(row.executionId);

      if (candidate?.scope === args.scope) {
        saved = candidate;
        break;
      }
    }
  }

  if (saved?.scope === args.scope) {
    for (const [file, content] of Object.entries(saved.files)) {
      checkpointPathSchema.parse(file);
      await writeFileAtomically(path.join(args.dir, file), content);
    }

    await args.harness.saveCheckpoint(args.fence, args.scope, saved.files);

    const files = Object.keys(saved.files);
    const batches = (stage: string) => {
      return files.filter((file) =>
        new RegExp(`^OUT/${stage}/[0-9]+\\.inputs\\.sha$`).test(file),
      ).length;
    };

    args.log?.(
      `checkpoint: restored ${files.length} files; ${batches('analyze')} analyze, ${batches('qualify')} qualify, ${batches('review')} review batches`,
    );
  }

  return async (selected) => {
    const files = selected ?? (await checkpointFiles(args.dir));
    const patch: Record<string, string | null> = {};

    for (const file of files) {
      checkpointPathSchema.parse(file);

      const target = path.join(args.dir, file);
      const stat = await lstat(target).catch(() => null);

      if (stat && !stat.isFile()) {
        throw new Error(`Checkpoint is not a regular file: ${file}.`);
      }

      patch[file] = stat ? await readFile(target, 'utf8') : null;
    }

    await args.harness.saveCheckpoint(args.fence, args.scope, patch);
  };
};
