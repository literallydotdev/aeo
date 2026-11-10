import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolVersion } from '../bundle/contracts';
import { hasErrorCode } from '../stores/fs-errors';
import { stagePrompts } from '../codex-workflow/prompts';
import {
  currentMethod,
  methodFile,
  readRunMethod,
  resolveRunMethod,
  RunMethodChangedError,
  stagePromptsFile,
} from './run-method';

// ============================================================================
// Freezing a run's method (method release spec §3.1): a new run freezes the
// engine's method, a resume under the same method continues whatever the
// release, and a resume under another method, or of a directory started
// before methods were frozen, stops before anything is written.
// ============================================================================

let dir: string;
let bank: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aeo-method-'));
  bank = path.join(dir, 'BANK');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const frozenFile = async (method: unknown) => {
  await mkdir(bank, { recursive: true });
  await writeFile(path.join(bank, methodFile), JSON.stringify(method));
};

const storedMethod = async () => {
  return readFile(path.join(bank, methodFile), 'utf8').catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return undefined;
    }

    throw err;
  });
};

describe('run-method - resolveRunMethod()', () => {
  it("should freeze the engine's method in a new run directory", async () => {
    const method = await resolveRunMethod(dir, bank, { startedBefore: false });
    const stored: unknown = JSON.parse((await storedMethod()) ?? '');

    expect(method).toEqual(currentMethod());
    expect(stored).toEqual(currentMethod());
  });

  it('should resume a directory frozen under the same method by an earlier release', async () => {
    await frozenFile({ ...currentMethod(), toolVersion: '0.4.0-earlier' });

    const method = await resolveRunMethod(dir, bank, { startedBefore: true });

    expect(method.toolVersion).toBe('0.4.0-earlier');
  });

  it('should refuse a directory frozen under another method, naming the release that finishes it and the rejudgment', async () => {
    await frozenFile({
      ...currentMethod(),
      calculationVersion: currentMethod().calculationVersion + 1,
      toolVersion: '9.9.9',
    });

    const resume = resolveRunMethod(dir, bank, { startedBefore: true });

    await expect(resume).rejects.toThrow(RunMethodChangedError);
    await expect(resume).rejects.toThrow(
      `npx literally-aeo@9.9.9 run --output ${dir}`,
    );
    await expect(resume).rejects.toThrow(
      `literally-aeo rejudge ${dir} --output <new-dir>`,
    );
  });

  it('should refuse a directory started before methods were frozen, writing nothing', async () => {
    const resume = resolveRunMethod(dir, bank, { startedBefore: true });

    await expect(resume).rejects.toThrow(RunMethodChangedError);
    await expect(resume).rejects.toThrow(
      `npx literally-aeo@0.3.0 run --output ${dir}`,
    );
    expect(await storedMethod()).toBeUndefined();
  });

  it('should refuse a method file it cannot read rather than re-choose the method', async () => {
    await frozenFile({ version: 1, calculationVersion: 1 });

    await expect(
      resolveRunMethod(dir, bank, { startedBefore: true }),
    ).rejects.toThrow('is not a frozen method file');
  });

  it('should record the release it was frozen by', () => {
    expect(currentMethod().toolVersion).toBe(toolVersion);
  });
});

describe('run-method - the stage prompts a run keeps', () => {
  const storedPrompts = async (): Promise<unknown> => {
    const text = await readFile(path.join(bank, stagePromptsFile), 'utf8');
    const value: unknown = JSON.parse(text);

    return value;
  };

  it('should save the stage prompts with the method, before a new run does anything', async () => {
    await resolveRunMethod(dir, bank, { startedBefore: false });

    expect(await storedPrompts()).toEqual({ version: 1, stagePrompts });
    expect(await readRunMethod(dir, bank, { startedBefore: true })).toEqual({
      kind: 'frozen',
      method: currentMethod(),
      stagePrompts,
    });
  });

  it('should keep the prompts a run saved, whatever the installed engine says later', async () => {
    await resolveRunMethod(dir, bank, { startedBefore: false });
    await writeFile(
      path.join(bank, stagePromptsFile),
      JSON.stringify({ version: 1, stagePrompts: { analyze: 'As it was.' } }),
    );

    await resolveRunMethod(dir, bank, { startedBefore: true });

    expect(await storedPrompts()).toEqual({
      version: 1,
      stagePrompts: { analyze: 'As it was.' },
    });
  });

  it('should give its prompts to a directory that froze the same method before prompts were kept', async () => {
    await frozenFile(currentMethod());

    await resolveRunMethod(dir, bank, { startedBefore: true });

    expect(await storedPrompts()).toEqual({ version: 1, stagePrompts });
  });

  it('should tell a run from before the freeze from a directory the local engine never ran', async () => {
    expect(await readRunMethod(dir, bank, { startedBefore: true })).toEqual({
      kind: 'before_freeze',
    });
    expect(await readRunMethod(dir, bank, { startedBefore: false })).toEqual({
      kind: 'not_recorded',
    });
  });

  it('should refuse a damaged record rather than state another method', async () => {
    await resolveRunMethod(dir, bank, { startedBefore: false });
    await writeFile(path.join(bank, stagePromptsFile), '{"version":1}');

    await expect(
      readRunMethod(dir, bank, { startedBefore: true }),
    ).rejects.toThrow(/stage-prompts\.json .* is not a frozen method file/);
  });
});
