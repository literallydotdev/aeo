import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { hasErrorCode } from '../stores/fs-errors';

// ============================================================================
// One writer per run directory (specs/aeo-open-source-cli-spec.md §5). The
// lock is a file naming its owner's host and process; a second writer fails
// before any paid work. A lock whose process is gone on this host is
// abandoned: the next writer takes it over and says so. Shared or network
// filesystems across hosts are outside this guarantee; the hosted pipeline
// keeps its database fence.
// ============================================================================

export const writerLockFile = 'WRITER.lock';

const lockSchema = z.object({
  host: z.string(),
  pid: z.number().int(),
  purpose: z.string(),
  acquiredAt: z.string(),
});

export type WriterLockOwner = z.infer<typeof lockSchema>;

/** Thrown when another live process holds the run directory. */
export class WriterLockHeldError extends Error {
  readonly owner: WriterLockOwner;

  constructor(dir: string, owner: WriterLockOwner) {
    super(
      `Another writer holds ${dir}: ${owner.purpose}, process ${owner.pid} on ${owner.host} since ${owner.acquiredAt}. Please wait for it to finish; if it is gone from another machine, remove ${writerLockFile} by hand.`,
    );
    this.name = 'WriterLockHeldError';
    this.owner = owner;
  }
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    // EPERM: the process exists under another user.
    return hasErrorCode(err, 'EPERM');
  }
};

const readOwner = async (
  file: string,
): Promise<WriterLockOwner | undefined> => {
  const text = await readFile(file, 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });

  if (text === undefined) {
    return undefined;
  }

  const parsed = lockSchema.safeParse(JSON.parse(text));

  // An unreadable lock file is a torn write by a writer that died writing it.
  return parsed.success
    ? parsed.data
    : { host: hostname(), pid: -1, purpose: 'unknown', acquiredAt: '' };
};

export type WriterLock = {
  /** The abandoned lock this writer took over, if any. */
  takenOver: WriterLockOwner | undefined;
  release: () => Promise<void>;
};

/** acquireWriterLock takes the run directory for this process, or throws
 * WriterLockHeldError while a live writer holds it. */
export const acquireWriterLock = async (
  dir: string,
  purpose: string,
): Promise<WriterLock> => {
  const file = path.join(dir, writerLockFile);
  const owner: WriterLockOwner = {
    host: hostname(),
    pid: process.pid,
    purpose,
    acquiredAt: new Date().toISOString(),
  };
  let takenOver: WriterLockOwner | undefined;

  for (;;) {
    try {
      await writeFile(file, JSON.stringify(owner), { flag: 'wx' });
      break;
    } catch (err) {
      if (!hasErrorCode(err, 'EEXIST')) {
        throw err;
      }
    }

    const current = await readOwner(file);

    if (current === undefined) {
      continue;
    }

    const abandoned =
      current.host === owner.host &&
      current.pid !== process.pid &&
      !isProcessAlive(current.pid);

    if (!abandoned) {
      throw new WriterLockHeldError(dir, current);
    }

    takenOver = current;
    await rm(file, { force: true });
  }

  const release = async () => {
    const current = await readOwner(file);

    if (current?.pid === owner.pid && current.host === owner.host) {
      await rm(file, { force: true });
    }
  };

  return { takenOver, release };
};

/** live: the process runs on this host; abandoned: it is gone from this
 * host; unknown: it belongs to another host, which this one cannot ask. */
export type WriterLockState = 'live' | 'abandoned' | 'unknown';

/** readWriterLock reports who holds a run directory without taking it:
 * undefined when no writer does. */
export const readWriterLock = async (
  dir: string,
): Promise<{ owner: WriterLockOwner; state: WriterLockState } | undefined> => {
  const owner = await readOwner(path.join(dir, writerLockFile)).catch(
    // A lock torn mid-write reads as an unknown owner, never as no writer.
    () => ({ host: '', pid: -1, purpose: 'unknown', acquiredAt: '' }),
  );

  if (owner === undefined) {
    return undefined;
  }

  let state: WriterLockState = 'unknown';

  if (owner.host === hostname()) {
    state = owner.pid > 0 && isProcessAlive(owner.pid) ? 'live' : 'abandoned';
  }

  return { owner, state };
};
