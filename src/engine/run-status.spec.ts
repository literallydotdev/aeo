import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRecorder, probeTraceOf } from '../bundle/recorder';
import { writerLockFile } from '../bundle/writer-lock';
import { capturePlan } from '../capture-manifest';
import { auditFileSchema, localReportKey, toAuditConfig } from './audit-file';
import { budgetFile } from './budget';
import { bankDir } from './local-run';
import { auditCopyFile } from './run-configuration';
import { readRunStatus, spendCategoryOf } from './run-status';
import { exampleAuditFile } from './templates';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-status-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exampleFile = auditFileSchema.parse(exampleAuditFile);
const examplePlan = capturePlan(
  toAuditConfig(exampleFile),
  exampleFile.surfaces,
);
const digests = {
  measurementDigest: 'a'.repeat(64),
  planDigest: 'b'.repeat(64),
};

const ledgerCall = (
  callId: string,
  role: string,
  { reservedUsd, costUsd }: { reservedUsd: number; costUsd?: number },
) => {
  return {
    callId,
    role,
    reservedUsd,
    inputTokens: 1000,
    maxOutputTokens: 1000,
    ...(costUsd !== undefined && {
      usage: { costUsd, inputTokens: 900, outputTokens: 100 },
    }),
  };
};

/** A run stopped at its cap halfway through capture: two answers banked,
 * one failed, a ledger across every category, the writer still live. */
const createStoppedRun = async () => {
  const dir = path.join(root, 'run');
  const bank = path.join(dir, bankDir);
  const [first, second, third] = examplePlan.units;

  if (!first || !second || !third) {
    throw new Error('The example plan has fewer than three units.');
  }

  await mkdir(bank, { recursive: true });
  await writeFile(
    path.join(dir, auditCopyFile),
    JSON.stringify(exampleAuditFile),
  );
  await writeFile(
    path.join(bank, `${localReportKey(exampleFile)}.jsonl`),
    [
      ...[first, second].map((unit) => ({
        status: 'captured',
        ...unit,
        capturedAt: '2026-11-04T10:00:00.000Z',
        probe: {
          promptId: unit.promptId,
          promptText: unit.promptText,
          promptCategory: 'product_recommendation',
          modelName: unit.surface,
          runIndex: unit.runIndex,
          text: 'Northwind Data is one option.',
        },
      })),
      {
        status: 'failed',
        ...third,
        failedAt: '2026-11-04T10:01:00.000Z',
        kind: 'capacity',
        attempts: 3,
        lastError: 'capacity',
      },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  );
  await writeFile(
    path.join(bank, 'model-budget.json'),
    JSON.stringify({
      limits: {
        maxUsd: 5,
        maxTokens: 1_000_000,
        deadlineAt: '2026-11-05T00:00:00.000Z',
      },
      calls: Object.fromEntries(
        [
          ledgerCall('p1', 'probe:chatgpt', {
            reservedUsd: 0.05,
            costUsd: 0.04,
          }),
          ledgerCall('p2', 'probe:gemini', { reservedUsd: 0.05 }),
          ledgerCall('s1', 'stage:analyze', { reservedUsd: 1, costUsd: 1.25 }),
          ledgerCall('h1', 'perception', { reservedUsd: 0.2, costUsd: 0.1 }),
          ledgerCall('r1', 'research_search', {
            reservedUsd: 0.01,
            costUsd: 0.01,
          }),
        ].map((call) => [call.callId, call]),
      ),
    }),
  );
  await writeFile(
    path.join(dir, budgetFile),
    JSON.stringify({
      version: 1,
      original: { maxUsd: 4, maxTokens: 1_000_000, maxHours: 6 },
      current: { maxUsd: 5, maxTokens: 1_000_000, maxHours: 6 },
      deadlineAt: '2026-11-05T00:00:00.000Z',
      amendments: [],
    }),
  );

  const recorder = await openRecorder(dir, {
    origin: 'local',
    runId: '01M2STATUSAAAAAAAAAAAAAAAA',
    ...digests,
  });
  const attempt = await probeTraceOf(recorder, 'probe').start({
    surface: 'gemini',
    promptId: third.promptId,
    promptText: third.promptText,
    runIndex: third.runIndex,
    attempt: 1,
    requestedModel: 'google/gemini-3-flash',
  });

  await attempt.end({
    outcome: 'failed',
    kind: 'capacity',
    error: 'overloaded',
  });
  await recorder.record('run_failed', {
    error: 'ModelBudgetError',
    reason: 'Insufficient remaining model budget',
  });
  await writeFile(
    path.join(dir, writerLockFile),
    JSON.stringify({
      host: hostname(),
      pid: process.pid,
      purpose: 'literally-aeo run',
      acquiredAt: '2026-11-04T09:59:00.000Z',
    }),
  );

  return dir;
};

describe('run-status - spendCategoryOf()', () => {
  it('should map ledger roles to the four kinds of paid work', () => {
    const categories = [
      'stage:review',
      'probe:claude',
      'search:dataforseo',
      'research_search',
      'premiseVerifier',
    ].map(spendCategoryOf);

    expect(categories).toEqual([
      'stages',
      'probes',
      'search',
      'search',
      'hostCalls',
    ]);
  });
});

describe('run-status - readRunStatus()', () => {
  it('should report a run stopped at its cap: phase, answers, spend and the stop', async () => {
    const dir = await createStoppedRun();

    const status = await readRunStatus(dir);

    expect(status?.state).toBe('resumable');
    expect(status?.phase).toBe('stopped');
    expect(status?.lastActivity).toMatchObject({
      kind: 'probe',
      role: 'gemini',
      open: false,
    });
    expect(status?.answers).toEqual({
      planned: examplePlan.units.length,
      captured: 2,
      failed: 1,
    });
    expect(status?.spend.capUsd).toBe(5);
    expect(status?.spend.byCategory).toEqual({
      probes: { usd: 0.09, calls: 2 },
      stages: { usd: 1.25, calls: 1 },
      hostCalls: { usd: 0.1, calls: 1 },
      search: { usd: 0.01, calls: 1 },
    });
    expect(status?.spend.openUsd).toBeCloseTo(0.05);
    expect(status?.spend.chargedUsd).toBeCloseTo(1.45);
    expect(status?.spend.remainingUsd).toBeCloseTo(3.55);
    expect(status?.writer?.state).toBe('live');
    expect(status?.stoppedAtBudget).toBe(true);
    expect(status?.lastError?.reason).toBe(
      'Insufficient remaining model budget',
    );
  });

  it('should leave the directory exactly as it found it', async () => {
    const dir = await createStoppedRun();
    const list = async () => {
      return (await readdir(dir, { recursive: true })).sort();
    };
    const before = await list();

    await readRunStatus(dir);

    expect(await list()).toEqual(before);
  });

  it('should count only planned units when the bank holds others', async () => {
    const dir = await createStoppedRun();
    const unplanned = {
      status: 'captured',
      sectionKey: 'removed_section',
      promptId: 'gone',
      promptText: 'A question no longer asked.',
      surface: 'chatgpt',
      runIndex: 1,
      capturedAt: '2026-11-01T10:00:00.000Z',
      probe: {
        promptId: 'gone',
        promptText: 'A question no longer asked.',
        promptCategory: 'product_recommendation',
        modelName: 'chatgpt',
        runIndex: 1,
        text: 'An answer.',
      },
    };

    await writeFile(
      path.join(dir, bankDir, `${localReportKey(exampleFile)}.jsonl`),
      `${JSON.stringify(unplanned)}\n`,
      { flag: 'a' },
    );
    const status = await readRunStatus(dir);

    expect(status?.answers.captured).toBe(2);
  });

  it('should say a directory without a run holds none', async () => {
    const status = await readRunStatus(path.join(root, 'empty'));

    expect(status).toBeUndefined();
  });
});
