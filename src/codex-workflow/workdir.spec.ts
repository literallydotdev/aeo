import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFixtureConfig } from '../agents/__fixtures__/copy';
import type { CapturedUnitRecord } from '../stores/ports';
import {
  answerFilePath,
  answerPathSegment,
  answerSectionPrefix,
  materializeWorkdir,
} from './workdir';

const unit = (sectionKey: string, promptId = 'p1') => {
  return { sectionKey, promptId, surface: 'chatgpt', runIndex: 1 };
};

describe('workdir - answerFilePath()', () => {
  it('should keep the path of a snake case key unchanged', () => {
    const result = answerFilePath(unit('typescript_api_hosting', 'tah1'));

    expect(result).toBe('ANSWERS/typescript_api_hosting/tah1/chatgpt-1.md');
  });

  it('should NOT let a key traverse or nest out of its section folder', () => {
    const result = answerFilePath(unit('Märkte/../Éditeurs', '../../x'));

    expect(result).toBe(
      'ANSWERS/%4D%C3%A4rkte%2F%2E%2E%2F%C3%89diteurs/%2E%2E%2F%2E%2E%2Fx/chatgpt-1.md',
    );
  });

  it('should give distinct keys distinct segments, even folded to one case', () => {
    const keys = [
      'hosting',
      'Hosting',
      'HOSTING',
      'host/ing',
      'host%2Fing',
      'host.ing',
      '.',
      '..',
      'a b',
      'a%20b',
    ];

    const segments = keys.map((key) => answerPathSegment(key).toLowerCase());

    expect(new Set(segments).size).toBe(keys.length);
  });

  it('should refuse an empty segment', () => {
    expect(() => answerPathSegment('')).toThrow(/empty path segment/);
  });

  it('should match its section prefix', () => {
    const key = 'a/b';

    const result = answerFilePath(unit(key)).startsWith(
      answerSectionPrefix(key),
    );

    expect(result).toBe(true);
  });
});

describe('workdir - materializeWorkdir()', () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aeo-workdir-'));
    dir = path.join(root, 'run', 'work');
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should write every answer of a traversing key inside ANSWERS/', async () => {
    const sectionKey = '../../escaped';
    const config = {
      ...copyFixtureConfig,
      sections: [{ ...copyFixtureConfig.sections[0], key: sectionKey }],
    };
    const captured = [
      {
        status: 'captured',
        ...unit(sectionKey),
        promptText: 'Which tools?',
        capturedAt: '2026-11-03T10:00:00.000Z',
        probe: { modelName: 'chatgpt', runIndex: 1, text: 'An answer.' },
      },
    ] as unknown as CapturedUnitRecord[];

    const answers = await materializeWorkdir({
      dir,
      config: config as typeof copyFixtureConfig,
      captured,
      copyRules: '',
    });

    expect(answers.map((answer) => answer.file)).toEqual([
      'ANSWERS/%2E%2E%2F%2E%2E%2Fescaped/p1/chatgpt-1.md',
    ]);
    // The old join resolved ANSWERS/../../escaped to <root>/run/escaped.
    expect(await readdir(path.join(root, 'run'))).toEqual(['work']);
    expect(await readdir(path.join(dir, 'ANSWERS'))).toEqual(
      expect.arrayContaining(['%2E%2E%2F%2E%2E%2Fescaped']),
    );
  });
});
