import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { hasErrorCode } from './fs-errors';
import {
  publicationTripleSchema,
  type PublicationHistoryEntry,
} from './publication-history';
import { serializeRunFile } from './run-lifecycle';
import { StoreConflictError } from './versions';

const lockAttempts = 40;
const lockRetryDelayMs = 50;

const historyEntrySchema = publicationTripleSchema.extend({
  firstPublishedAt: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),
  origin: z.enum(['publication', 'backfill', 'legacy_import']),
});

export const filePublicationSchema = publicationTripleSchema
  .extend({
    history: z.array(historyEntrySchema).optional(),
  })
  .superRefine((pointer, context) => {
    if (pointer.history === undefined) {
      return;
    }

    const key = (entry: z.infer<typeof publicationTripleSchema>) => {
      return JSON.stringify([
        entry.reportKey,
        entry.runId,
        entry.configVersion,
        entry.copyVersion,
      ]);
    };
    const identities = pointer.history.map(key);

    if (
      !identities.includes(key(pointer)) ||
      new Set(identities).size !== identities.length ||
      pointer.history.some((entry) => entry.reportKey !== pointer.reportKey)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'File publication history must include its current triple exactly once',
      });
    }
  });

export type FilePublication = z.infer<typeof filePublicationSchema>;

export const readFilePublication = async (
  directory: string,
  reportKey: string,
): Promise<FilePublication | null> => {
  try {
    const pointer = filePublicationSchema.parse(
      JSON.parse(await readFile(join(directory, 'published.json'), 'utf8')),
    );

    if (
      pointer.reportKey !== reportKey ||
      pointer.history?.some((entry) => entry.reportKey !== reportKey)
    ) {
      throw new StoreConflictError(
        `Published file history belongs to another report than ${reportKey}.`,
      );
    }

    return pointer;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  }
};

/** Old pointers prove only their own publication; their original date is unknown. */
export const filePublicationHistory = (
  pointer: FilePublication,
  recordedAt: string,
): PublicationHistoryEntry[] => {
  const history = pointer.history ?? [
    {
      reportKey: pointer.reportKey,
      runId: pointer.runId,
      configVersion: pointer.configVersion,
      copyVersion: pointer.copyVersion,
      firstPublishedAt: null,
      recordedAt,
      origin: 'backfill',
    },
  ];

  return history;
};

/** One lock protects read/append/rename across instances and processes. A stale
 * lock fails closed rather than risking deletion of another writer's lock. */
export const withFilePublicationLock = async <T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> => {
  await mkdir(directory, { recursive: true });

  const lockPath = join(directory, 'published.lock');

  return serializeRunFile(lockPath, async () => {
    let lock;

    for (let attempt = 0; attempt < lockAttempts; attempt++) {
      try {
        lock = await open(lockPath, 'wx', 0o600);

        break;
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
          throw error;
        }

        if (attempt < lockAttempts - 1) {
          await delay(lockRetryDelayMs);
        }
      }
    }

    if (!lock) {
      throw new StoreConflictError(
        `Another file publication holds the writer lock: ${lockPath}.`,
      );
    }

    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));

      return await action();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  });
};

export const writeFilePublication = async (
  directory: string,
  pointer: FilePublication & Record<string, unknown>,
): Promise<void> => {
  filePublicationSchema.parse(pointer);

  await writeAtomicJson(directory, 'published.json', pointer);
};

/** Caller holds the publication lock; no partial JSON can become readable. */
export const writeAtomicJson = async (
  directory: string,
  name: string,
  value: unknown,
): Promise<void> => {
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);

  try {
    const file = await open(temporary, 'wx', 0o600);

    try {
      await file.writeFile(JSON.stringify(value), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, join(directory, name));

    const dir = await open(directory, 'r');

    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    });
  }
};
