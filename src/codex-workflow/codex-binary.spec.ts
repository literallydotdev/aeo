import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexArgs, codexBinaryAt, resolveCodexBinary } from './codex-binary';

const packageRoot = path.resolve(import.meta.dirname, '..', '..');

describe('codex-binary - resolveCodexBinary()', () => {
  it("should resolve the package's own Codex dependency, never PATH", () => {
    const binary = resolveCodexBinary({ PATH: '/nowhere' });

    expect(binary.source).toBe('dependency');
    expect(binary.command).toBe(process.execPath);
    expect(binary.path).toMatch(/@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    expect(codexArgs(binary, ['--version'])).toEqual([
      binary.path,
      '--version',
    ]);
  });

  it('should report the version package.json pins, from the installed manifest', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };

    const binary = resolveCodexBinary({});

    expect(binary.version).toBe(manifest.dependencies['@openai/codex']);
  });

  it('should let AEO_CODEX_BIN override the dependency, its version unknown', () => {
    const binary = resolveCodexBinary({
      AEO_CODEX_BIN: '/opt/codex/bin/codex',
    });

    expect(binary).toEqual(codexBinaryAt('/opt/codex/bin/codex'));
    expect(binary).toEqual({
      command: '/opt/codex/bin/codex',
      prefixArgs: [],
      path: '/opt/codex/bin/codex',
      source: 'AEO_CODEX_BIN',
      version: null,
    });
  });
});
