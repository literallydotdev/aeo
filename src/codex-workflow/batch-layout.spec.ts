import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stableBatchLayout } from './batch-layout';

const allFiles = ['a', 'b', 'c', 'd', 'e'];

describe('BatchLayout - stableBatchLayout()', () => {
  it('should keep accepted batch membership when an earlier missing capture arrives', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeo-batch-layout-'));

    try {
      const first = await stableBatchLayout(dir, {
        config: { version: 1 },
        files: ['b', 'c', 'd', 'e'],
        size: 2,
      });

      expect(first.batches).toEqual([
        ['b', 'c'],
        ['d', 'e'],
      ]);

      const resumed = await stableBatchLayout(dir, {
        config: { version: 1 },
        files: allFiles,
        size: 2,
      });

      expect(resumed.batches).toEqual([['b', 'c'], ['d', 'e'], ['a']]);

      const repeated = await stableBatchLayout(dir, {
        config: { version: 1 },
        files: allFiles,
        size: 2,
      });

      expect(repeated.batches).toEqual(resumed.batches);

      const rescoped = await stableBatchLayout(dir, {
        config: { version: 2 },
        files: allFiles,
        size: 2,
      });

      expect(rescoped.batches).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
