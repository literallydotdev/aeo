import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkpointFiles } from './checkpoint';

const savedSessionSchema = z.looseObject({
  contract: z.string(),
  threadId: z.string(),
});

export type SavedSession = {
  contract: string;
  threadId: string;
};

export const readSession = async (
  dir: string,
  { label, contract }: { label: string; contract: string },
): Promise<SavedSession | null> => {
  const raw = await readFile(
    path.join(dir, 'JOURNAL', `${label}.session.json`),
    'utf8',
  ).catch(() => null);

  if (!raw) {
    return null;
  }

  const parsed = savedSessionSchema.safeParse(JSON.parse(raw));

  if (!parsed.success) {
    return null;
  }

  const session = parsed.data;
  const isResumable =
    session.contract === contract && /^[a-f0-9-]{36}$/.test(session.threadId);

  return isResumable ? session : null;
};

export const saveSession = async (
  dir: string,
  label: string,
  session: SavedSession,
): Promise<string[]> => {
  const file = `JOURNAL/${label}.session.json`;

  await writeFile(path.join(dir, file), JSON.stringify(session));

  const rollouts = (await checkpointFiles(dir, '.codex-home/sessions')).filter(
    (entry) => entry.includes(session.threadId),
  );

  return [file, `JOURNAL/${label}.md`, ...rollouts];
};

/** A saved conversation that could not be resumed (its rollout gone, the
 * thread expired) is dropped, so the next session of the batch starts fresh.
 * Returns the file for the checkpoint to record as deleted. */
export const forgetSession = async (
  dir: string,
  label: string,
): Promise<string[]> => {
  const file = `JOURNAL/${label}.session.json`;

  await rm(path.join(dir, file), { force: true });

  return [file];
};
