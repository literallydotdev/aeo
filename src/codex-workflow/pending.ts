import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Replace a file in one step: a failed write leaves the previous content
 * (a verifier checkpoint, a restored output) intact. The temporary name is
 * unique so concurrent writers never rename each other's half-written file;
 * `checkpointFiles` skips the `.tmp` suffix. */
export const writeFileAtomically = async (file: string, content: string) => {
  await mkdir(path.dirname(file), { recursive: true });

  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const writePendingJson = async (file: string, value: unknown) => {
  await writeFileAtomically(file, JSON.stringify(value));
};
