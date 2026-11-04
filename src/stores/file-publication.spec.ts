import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  filePublicationHistory,
  filePublicationSchema,
  readFilePublication,
  withFilePublicationLock,
  writeFilePublication,
} from './file-publication';

const directories: string[] = [];

const triple = {
  reportKey: 'example',
  runId: 'first',
  configVersion: 1,
  copyVersion: 1,
};

const recordedAt = '2026-09-09T12:00:00.000Z';

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createDirectory = async () => {
  const value = await mkdtemp(join(tmpdir(), 'aeo-publication-history-'));

  directories.push(value);

  return value;
};

const readPointer = async (path: string) => {
  const pointer = await readFilePublication(path, triple.reportKey);

  if (!pointer) {
    throw new Error(`Missing publication pointer in ${path}.`);
  }

  return pointer;
};

describe('file-publication - publication pointer', () => {
  it('should retain a legacy pointer as one publication with an unknown original date', () => {
    const pointer = filePublicationSchema.parse(triple);

    expect(filePublicationHistory(pointer, recordedAt)).toEqual([
      { ...triple, firstPublishedAt: null, recordedAt, origin: 'backfill' },
    ]);
  });

  it('should refuse explicit history that loses the current pointer, duplicates identities or crosses reports', () => {
    const current = filePublicationHistory(triple, recordedAt)[0];

    for (const history of [
      [],
      [{ ...current, runId: 'other' }],
      [current, current],
      [current, { ...current, reportKey: 'private-report' }],
    ]) {
      expect(
        filePublicationSchema.safeParse({ ...triple, history }).success,
      ).toBe(false);
    }
  });

  it('should serialize independent writers and commit the pointer with its entire history', async () => {
    const path = await createDirectory();

    await writeFile(join(path, 'published.json'), JSON.stringify(triple));

    const append = (runId: string) => {
      return withFilePublicationLock(path, async () => {
        const previous = await readPointer(path);
        const history = filePublicationHistory(previous, recordedAt);

        // Concurrent writers must each see the preceding committed history.
        await delay(5);

        const current = { ...triple, runId };

        history.push({
          ...current,
          firstPublishedAt: recordedAt,
          recordedAt,
          origin: 'publication',
        });
        await writeFilePublication(path, { ...current, history });
      });
    };

    await Promise.all([append('second'), append('third')]);

    const pointer = await readPointer(path);

    expect(['second', 'third']).toContain(pointer.runId);
    expect(pointer.history?.at(-1)?.runId).toBe(pointer.runId);
    expect(pointer.history?.map((entry) => entry.runId).sort()).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(await readdir(path)).toEqual(['published.json']);
  });

  it('should release its lock after a failed publication and preserve the previous complete pointer', async () => {
    const path = await createDirectory();
    const bytes = JSON.stringify(triple);

    await writeFile(join(path, 'published.json'), bytes);
    await expect(
      withFilePublicationLock(path, () =>
        Promise.reject(new Error('Validation failed')),
      ),
    ).rejects.toThrow('Validation failed');
    expect(await readFile(join(path, 'published.json'), 'utf8')).toBe(bytes);
    expect(await readdir(path)).toEqual(['published.json']);
  });

  it('should remove its temporary file when the atomic pointer replacement fails', async () => {
    const path = await createDirectory();

    await mkdir(join(path, 'published.json'));
    await expect(
      withFilePublicationLock(path, () => writeFilePublication(path, triple)),
    ).rejects.toThrow();
    expect(await readdir(path)).toEqual(['published.json']);
  });
});
