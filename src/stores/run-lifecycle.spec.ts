import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRequestSchema } from '../schema';
import { MemoryRunStore } from './memory';
import { FileRunStore } from './files';
import type { RunRecord } from './ports';

const row = (): RunRecord => {
  return {
    runId: 'r1',
    reportKey: 'synthetic',
    request: runRequestSchema.parse({ reportKey: 'synthetic', runId: 'r1' }),
    status: 'queued',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    partialFailures: [],
    logLocation: null,
  };
};

describe('run-lifecycle - evaluateRunClaim() and serializeRunFile()', () => {
  it('should serialize racing file completions across store instances and record one terminal outcome', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aeo-run-race-'));

    try {
      const first = new FileRunStore(directory);
      const second = new FileRunStore(directory);

      await first.start(row());

      const owner = { batchJobId: 'batch-1', attempt: 1 };

      await first.claim('r1', owner);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 ? first : second).finish('r1', {
            status: index % 2 ? 'cancelled' : 'completed',
            finishedAt: new Date().toISOString(),
            partialFailures: [],
          }),
        ),
      );

      const records = (
        await readFile(path.join(directory, 'runs.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as RunRecord);

      expect(
        records.filter((record) =>
          ['cancelled', 'completed'].includes(record.status),
        ),
      ).toHaveLength(1);
      expect(
        await second.reconcile(
          'r1',
          {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            partialFailures: [],
          },
          owner,
        ),
      ).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should claim retries under the same job and refuse duplicate jobs and older attempts', async () => {
    const store = new MemoryRunStore();

    await store.start(row());
    expect(
      (await store.claim('r1', { batchJobId: 'batch-1', attempt: 1 })).status,
    ).toBe('claimed');
    expect(
      (await store.claim('r1', { batchJobId: 'batch-2', attempt: 1 })).status,
    ).toBe('duplicate');
    expect(
      (await store.claim('r1', { batchJobId: 'batch-1', attempt: 2 })).status,
    ).toBe('claimed');
    expect(
      await store.reconcile(
        'r1',
        {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          partialFailures: [],
        },
        { batchJobId: 'batch-1', attempt: 1 },
      ),
    ).toBe(false);
  });

  it('should keep terminal outcomes immutable and record retryable termination without finishing', async () => {
    const store = new MemoryRunStore();

    await store.start(row());

    const owner = { batchJobId: 'batch-1', attempt: 1 };

    await store.claim('r1', owner);
    await store.reconcile(
      'r1',
      {
        status: 'running',
        finishedAt: null,
        partialFailures: [],
        failureReason: 'terminated',
      },
      owner,
    );
    expect((await store.get('r1'))?.status).toBe('running');
    await store.reconcile(
      'r1',
      {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
        partialFailures: [],
      },
      owner,
    );
    expect((await store.claim('r1', owner)).status).toBe('terminal');
    expect(
      await store.reconcile(
        'r1',
        {
          status: 'completed',
          finishedAt: new Date().toISOString(),
          partialFailures: [],
        },
        owner,
      ),
    ).toBe(false);
  });
});
