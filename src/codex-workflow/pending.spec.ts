import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkpointFiles } from './checkpoint';
import { writePendingJson } from './pending';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();

  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

describe('Pending - writePendingJson()', () => {
  it('should retain the previous checkpoint if storage fills during the next write', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'aeo-pending-'));
    const file = path.join(dir, 'PENDING/copy-edits.json');
    const originalWrite = (await vi.importActual<typeof fs>('node:fs/promises'))
      .writeFile;

    try {
      await writePendingJson(file, { edits: ['first completed edit'] });

      const fault = vi
        .mocked(fs.writeFile)
        .mockImplementationOnce(async (target) => {
          await originalWrite(target, '{"edits":');
          expect(await checkpointFiles(dir)).toEqual([
            'PENDING/copy-edits.json',
          ]);
          throw Object.assign(new Error('No space left on device'), {
            code: 'ENOSPC',
          });
        });

      await expect(
        writePendingJson(file, { edits: ['next edit'] }),
      ).rejects.toMatchObject({ code: 'ENOSPC' });
      fault.mockImplementation(originalWrite);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
        edits: ['first completed edit'],
      });
      expect(await fs.readdir(path.dirname(file))).toEqual(['copy-edits.json']);
      await writePendingJson(file, { edits: ['next edit'] });
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
        edits: ['next edit'],
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
