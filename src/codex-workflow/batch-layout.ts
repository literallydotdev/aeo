import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { contentHash } from '../stores/content-hash';

const layoutSchema = z.object({
  scope: z.string(),
  size: z.number().int().positive(),
  batches: z.array(z.array(z.string())),
});

export type BatchLayout = z.infer<typeof layoutSchema>;

/** Filling a missing capture must not move every later accepted answer to
 * another batch. Existing membership stays fixed; new answers append. */
export type StableBatchLayoutOptions = {
  config: unknown;
  files: readonly string[];
  size: number;
};

export const stableBatchLayout = async (
  dir: string,
  { config, files, size }: StableBatchLayoutOptions,
): Promise<BatchLayout> => {
  const file = path.join(dir, 'OUT', 'batches.json');
  const scope = contentHash(config);
  const old = layoutSchema.safeParse(
    JSON.parse(await readFile(file, 'utf8').catch(() => 'null')),
  );
  const layout: BatchLayout =
    old.success && old.data.scope === scope && old.data.size === size
      ? old.data
      : { scope, size, batches: [] };

  const assigned = new Set(layout.batches.flat());
  const added = files.filter((answer) => !assigned.has(answer));

  for (let at = 0; at < added.length; at += size) {
    layout.batches.push(added.slice(at, at + size));
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(layout));

  return layout;
};
