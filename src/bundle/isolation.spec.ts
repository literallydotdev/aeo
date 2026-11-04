import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePlan } from '../capture-manifest';
import { bundlePaths, measurementDigest } from './contracts';
import { exportRun } from './export';
import {
  isolationLimitations,
  observedIsolation,
  summarizeIsolation,
} from './isolation';
import { readJournal } from './journal';
import { parseBundleJson } from './json';
import { openRecorder, probeTraceOf, type ExecutionRecorder } from './recorder';
import { readArchive } from './zip';
import {
  createSyntheticRun,
  syntheticConfig,
  syntheticRunId,
} from './__fixtures__/synthetic-run';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-isolation-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const syntheticDigests = {
  measurementDigest: measurementDigest({
    config: syntheticConfig,
    surfaces: ['chatgpt', 'perplexity'],
    sections: null,
  }),
  planDigest: capturePlan(syntheticConfig, ['chatgpt', 'perplexity']).digest,
};

const readEvents = async (dir: string) => {
  const text = await readFile(
    path.join(dir, 'JOURNAL/run/events.jsonl'),
    'utf8',
  );

  return readJournal(text).events;
};

/** One Codex stage session and one Cursor probe, as a run records them. */
const recordWork = async (recorder: ExecutionRecorder) => {
  const session = await recorder.start({
    kind: 'codex_session',
    stage: 'analyze',
    batch: 0,
    details: { sandbox: 'workspace-write' },
  });

  await session.finish({ outcome: 'succeeded' });

  const probe = await probeTraceOf(recorder, 'probe').start({
    surface: 'cursor',
    promptId: 'h1',
    promptText: 'Which hosted databases suit a small team?',
    runIndex: 1,
    attempt: 1,
    requestedModel: null,
  });

  await probe.end({ outcome: 'failed', kind: 'capacity', error: 'busy' });
};

describe('isolation - observedIsolation()', () => {
  it('should say native on an operator machine and container behind isolated workers', () => {
    vi.stubEnv('AEO_ISOLATED_ADAPTER', '');
    const native = observedIsolation();

    vi.stubEnv('AEO_ISOLATED_ADAPTER', '1');
    const container = observedIsolation();

    expect(native.boundary).toBe('native');
    expect(container.boundary).toBe('container');
  });
});

describe('isolation - summarizeIsolation()', () => {
  it('should report stage sandboxes and the agent CLIs that ran as the operator', async () => {
    vi.stubEnv('AEO_ISOLATED_ADAPTER', '');
    const recorder = await openRecorder(root, {
      origin: 'local',
      runId: syntheticRunId,
      ...syntheticDigests,
    });

    await recordWork(recorder);
    const isolation = summarizeIsolation(await readEvents(root));

    expect(isolation).toEqual({
      writers: ['native'],
      stageSandboxes: ['workspace-write'],
      agentCliAccounts: ['cursor'],
    });
    expect(isolationLimitations(isolation)).toHaveLength(2);
  });

  it('should never count a container writer as the operator', async () => {
    const recorder = await openRecorder(root, {
      origin: 'hosted',
      runId: syntheticRunId,
      isolation: { boundary: 'container', codexProbeSandbox: 'read-only' },
      ...syntheticDigests,
    });

    await recordWork(recorder);
    const isolation = summarizeIsolation(await readEvents(root));

    expect(isolation.writers).toEqual(['container']);
    expect(isolation.agentCliAccounts).toEqual([]);
    expect(isolationLimitations(isolation)).toEqual([]);
  });

  it('should keep a writer without a record unknown, never isolated', () => {
    const started = {
      seq: 0,
      id: '01M2ISOLATI0NAAAAAAAAAAAAA',
      type: 'run_started' as const,
      at: '2026-11-04T10:00:00.000Z',
      operationId: null,
      payload: { runtime: { tool: 'literally-aeo', version: '0.1.1' } },
      objects: [],
      previousDigest: null,
      digest: 'a'.repeat(64),
    };

    const isolation = summarizeIsolation([started]);

    expect(isolation.writers).toEqual(['unknown']);
    expect(isolationLimitations(isolation)[0]).toContain('unknown');
  });
});

describe('isolation - runtime.json', () => {
  it('should carry the run isolation and its disclosures into the bundle', async () => {
    vi.stubEnv('AEO_ISOLATED_ADAPTER', '');
    const run = await createSyntheticRun(path.join(root, 'run'));
    const recorder = await openRecorder(run.dir, {
      origin: 'local',
      runId: syntheticRunId,
      ...syntheticDigests,
    });

    await recordWork(recorder);
    const result = await exportRun(run.dir);
    const files = readArchive(await readFile(result.archive));
    const runtime = parseBundleJson(
      files.get(bundlePaths.runtime)?.toString('utf8') ?? '',
    );

    expect(runtime).toMatchObject({
      isolation: {
        writers: ['native'],
        stageSandboxes: ['workspace-write'],
        agentCliAccounts: ['cursor'],
      },
    });
    expect(JSON.stringify(runtime)).toContain('not reads');
  });
});
