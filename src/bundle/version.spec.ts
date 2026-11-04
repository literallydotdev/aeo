import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { toolId, toolVersion } from './contracts';

describe('contracts - toolVersion', () => {
  it('should be the package version and name, which every bundle records', async () => {
    const manifest: unknown = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    );

    expect(manifest).toMatchObject({ name: toolId, version: toolVersion });
  });
});
