import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { contentHash } from '../stores/content-hash';
import { hasErrorCode } from '../stores/fs-errors';
import { serializeRunFile } from '../stores/run-lifecycle';
import {
  createResearchSessionStore,
  researchStateKey,
  validateSessionMap,
  type AtomicResearchStorage,
  type ResearchOwner,
} from './session';

type FileLock = Awaited<ReturnType<typeof open>>;

// A held filesystem lock has one live process owner. Reclaim only a provably
// dead local PID.
const acquireWriterLock = async (lockPath: string): Promise<FileLock> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(lockPath, 'wx', 0o600);

      return lock;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }

      const pid = Number(await readFile(lockPath, 'utf8').catch(() => ''));

      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`Research file writer lock is held: ${lockPath}.`, {
          cause: error,
        });
      }

      try {
        process.kill(pid, 0);
      } catch (probe) {
        if (!hasErrorCode(probe, 'ESRCH')) {
          throw probe;
        }

        await unlink(lockPath);

        continue;
      }

      throw new Error(`Research file writer lock is held: ${lockPath}.`, {
        cause: error,
      });
    }
  }

  throw new Error(`Research file writer lock unavailable: ${lockPath}.`);
};

const readSessionState = async (filename: string): Promise<unknown> => {
  try {
    const state: unknown = JSON.parse(await readFile(filename, 'utf8'));

    return state;
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return {};
  }
};

export const createFileResearchSessionStore = (
  directory: string,
  assertOwned: (owner: ResearchOwner) => Promise<void>,
) => {
  const storage: AtomicResearchStorage = {
    update: (owner, action) => {
      const key = researchStateKey(owner);
      const filename = join(directory, `${contentHash(key)}.json`);

      return serializeRunFile(filename, async () => {
        await mkdir(dirname(filename), { recursive: true, mode: 0o700 });

        const lockPath = `${filename}.lock`;
        const lock = await acquireWriterLock(lockPath);
        const temporary = `${filename}.${randomUUID()}.tmp`;

        try {
          await lock.writeFile(String(process.pid));
          await lock.sync();
          await assertOwned(owner);

          const state = await readSessionState(filename);

          validateSessionMap(state);

          const result = action(state);
          const output = await open(temporary, 'wx', 0o600);

          try {
            await output.writeFile(JSON.stringify(state));
            await output.sync();
          } finally {
            await output.close();
          }

          await assertOwned(owner);
          await rename(temporary, filename);

          const directoryHandle = await open(dirname(filename), 'r');

          try {
            await directoryHandle.sync();
          } finally {
            await directoryHandle.close();
          }

          return result;
        } finally {
          // The temporary file is gone after a successful rename.
          await unlink(temporary).catch(() => undefined);
          await lock.close();
          await unlink(lockPath);
        }
      });
    },
  };

  return createResearchSessionStore(storage);
};
