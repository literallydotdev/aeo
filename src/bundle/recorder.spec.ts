import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hostModels } from '../codex-workflow/host-models';
import { createMemoryModelAccounting } from '../models/accounting';
import { withModelBudgetProtection } from '../models/budget-protection';
import {
  generateStructured,
  type StructuredTransport,
} from '../models/structured';
import { capturePlan } from '../capture-manifest';
import { readRunInputs } from '../codex-workflow/run-inputs';
import { bundlePaths, measurementDigest, objectPathPrefix } from './contracts';
import { exportRun, finalizeRevision } from './export';
import { readJournal } from './journal';
import {
  openRecorder,
  probeTraceOf,
  recordedOperationKinds,
  recordingAccounting,
} from './recorder';
import { capturedAnswerOf } from './trace-coverage';
import { checkTraceCoverage } from './verify-integrity';
import { readBundleSource } from './read';
import { verifyBundle } from './verify';
import {
  acquireWriterLock,
  WriterLockHeldError,
  writerLockFile,
} from './writer-lock';
import { readArchive, writeArchive } from './zip';
import {
  createSyntheticRun,
  syntheticConfig,
  syntheticRunId,
} from './__fixtures__/synthetic-run';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-recorder-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const readEvents = async (dir: string) => {
  const text = await readFile(
    path.join(dir, 'JOURNAL/run/events.jsonl'),
    'utf8',
  );

  return readJournal(text).events;
};

const syntheticDigests = {
  measurementDigest: measurementDigest({
    config: syntheticConfig,
    surfaces: ['chatgpt', 'perplexity'],
    sections: null,
  }),
  planDigest: capturePlan(syntheticConfig, ['chatgpt', 'perplexity']).digest,
};

describe('writer-lock - acquireWriterLock()', () => {
  it('should refuse a second writer while the first holds the directory', async () => {
    const first = await acquireWriterLock(root, 'first');

    const second = acquireWriterLock(root, 'second');

    await expect(second).rejects.toThrow(WriterLockHeldError);
    await first.release();
    await expect(acquireWriterLock(root, 'third')).resolves.toMatchObject({
      takenOver: undefined,
    });
  });

  it('should take over a lock whose process is gone', async () => {
    const gone = {
      host: hostname(),
      pid: 2 ** 22 + 1,
      purpose: 'crashed',
      acquiredAt: '2026-11-01T00:00:00.000Z',
    };

    await writeFile(path.join(root, writerLockFile), JSON.stringify(gone));
    const lock = await acquireWriterLock(root, 'resume');

    expect(lock.takenOver).toEqual(gone);
  });
});

describe('recorder - openRecorder()', () => {
  it('should freeze the plan on a new journal and resume an existing one', async () => {
    await openRecorder(root, {
      origin: 'local',
      runId: 'r1',
      ...syntheticDigests,
    });
    await openRecorder(root, {
      origin: 'local',
      runId: 'r1',
      ...syntheticDigests,
    });

    const types = (await readEvents(root)).map((event) => event.type);

    expect(types).toEqual(['run_started', 'plan_frozen', 'run_resumed']);
  });

  it('should set aside a journal frozen for another measurement', async () => {
    await openRecorder(root, {
      origin: 'local',
      runId: 'r1',
      ...syntheticDigests,
    });
    await openRecorder(root, {
      origin: 'local',
      runId: 'r1',
      ...syntheticDigests,
      measurementDigest: 'c'.repeat(64),
    });

    const entries = await readdir(path.join(root, 'JOURNAL'));

    expect(entries.some((entry) => entry.startsWith('run-superseded-'))).toBe(
      true,
    );
    expect((await readEvents(root)).map((event) => event.type)).toEqual([
      'run_started',
      'plan_frozen',
    ]);
  });
});

describe('recorder - recordingAccounting()', () => {
  it('should open a call at reservation and close it with the reported model', async () => {
    const recorder = await openRecorder(root, {
      origin: 'local',
      runId: 'r1',
      ...syntheticDigests,
    });
    const accounting = recordingAccounting(
      createMemoryModelAccounting({
        maxUsd: 1,
        maxTokens: 10_000,
        deadlineAt: '2099-01-01T00:00:00.000Z',
      }),
      recorder,
    );

    await accounting.reserve({
      callId: 'c1',
      role: 'perception',
      requestedModel: 'deepseek/v4',
      reservedUsd: 0.01,
      inputTokens: 100,
      maxOutputTokens: 100,
    });
    await accounting.settle('c1', {
      inputTokens: 90,
      outputTokens: 40,
      costUsd: 0.002,
    });
    await accounting.reserve({
      callId: 'c2',
      role: 'perception',
      reservedUsd: 0.01,
      inputTokens: 100,
      maxOutputTokens: 100,
    });

    const events = await readEvents(root);
    const finished = events.find(
      (event) => event.type === 'operation_finished',
    );
    const started = events.filter(
      (event) => event.type === 'operation_started',
    );

    expect(started).toHaveLength(2);
    // The provider did not report a model: never copied from the request.
    expect(finished?.payload.details).toMatchObject({
      resolvedModel: null,
      costUsd: 0.002,
    });
    expect(
      events.filter((event) => event.type === 'operation_finished'),
    ).toHaveLength(1);
  });
});

describe('recorder - generateStructured() through a recording accounting', () => {
  const role = hostModels().profile.roles.perception;
  const answer = { claims: ['fast'] };
  const transport: StructuredTransport = <T>() =>
    Promise.resolve({
      output: answer as T,
      text: JSON.stringify(answer),
      usage: {
        resolvedModel: 'deepseek/v4-0601',
        requestId: 'req-1',
        inputTokens: 50,
        outputTokens: 10,
      },
    });

  it('should record the exact request before dispatch and the response at settlement', async () => {
    const recorder = await openRecorder(root, {
      origin: 'local',
      runId: 'r1',
      ...syntheticDigests,
    });
    // Wrapped again, as the job's budget protection does: the hook must pass through.
    const accounting = withModelBudgetProtection(
      recordingAccounting(hostModels().accounting, recorder),
      hostModels().profile,
    );

    await generateStructured(
      {
        roleName: 'perception',
        role,
        schema: z.object({ claims: z.array(z.string()) }),
        system: 'You extract claims.',
        prompt: 'The answer text.',
        accounting,
      },
      transport,
    );

    const events = await readEvents(root);
    const started = events.find((event) => event.type === 'operation_started');
    const finished = events.find(
      (event) => event.type === 'operation_finished',
    );
    const inputs = z
      .record(z.string(), z.string())
      .parse(started?.payload.inputs);
    const outputs = z
      .record(z.string(), z.string())
      .parse(finished?.payload.outputs);
    const object = (digest: string | undefined) =>
      readFile(
        path.join(root, 'JOURNAL/run', objectPathPrefix, digest ?? ''),
        'utf8',
      );

    expect(Object.keys(inputs).sort()).toEqual([
      'prompt',
      'role',
      'schema',
      'system',
    ]);
    expect(await object(inputs.prompt)).toBe('The answer text.');
    expect(JSON.parse(await object(outputs.payload))).toEqual(answer);
    expect(finished?.payload.details).toMatchObject({
      resolvedModel: 'deepseek/v4-0601',
      requestId: 'req-1',
      responseRecorded: true,
    });
  });
});

describe('export - exportRun() with a run journal', () => {
  const recordedRun = async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));
    const recorder = await openRecorder(run.dir, {
      origin: 'local',
      runId: syntheticRunId,
      ...syntheticDigests,
    });
    const session = await recorder.start({
      kind: 'codex_session',
      stage: 'analyze',
      batch: 0,
      attempt: 1,
      inputs: { stdin: 'the packet' },
    });

    await session.finish({
      outcome: 'succeeded',
      outputs: { events: '{"type":"turn.completed"}\n' },
    });
    await recorder.start({ kind: 'host_model_call', role: 'perception' });

    return run;
  };

  it('should bundle the journal with its objects and verify its chain offline', async () => {
    const run = await recordedRun();

    const result = await exportRun(run.dir);
    const source = await readBundleSource(result.archive);
    const verification = verifyBundle(source.files, source.description);
    const coverage = verification.checks.find(
      (check) => check.id === 'trace.coverage',
    );

    expect(result.manifest.run.origin).toBe('local');
    expect(result.manifest.events.count).toBe(5);
    expect(
      [...source.files.keys()].filter((file) =>
        file.startsWith(objectPathPrefix),
      ),
    ).toHaveLength(2);
    expect(
      verification.checks.find((check) => check.id === 'trace.chain')?.outcome,
    ).toBe('pass');
    expect(coverage?.code).toBe('trace_partial');
    expect(coverage?.explanation).toContain(
      '2 operations recorded, 1 without an outcome at the exported cutoff',
    );
  });

  it('should record its revision in the journal and reuse it on re-export', async () => {
    const run = await recordedRun();

    const first = await exportRun(run.dir);
    const again = await exportRun(run.dir, {
      output: path.join(root, 'again.aeo.zip'),
    });
    const types = (await readEvents(run.dir)).map((event) => event.type);

    expect(types.at(-1)).toBe('revision_finalized');
    expect(types.filter((type) => type === 'revision_finalized')).toHaveLength(
      1,
    );
    expect(again.reusedRevision).toBe(true);
    expect(again.archiveSha256).toBe(first.archiveSha256);
  });

  it('should refuse to export while a writer holds the run directory', async () => {
    const run = await recordedRun();
    const writer = await acquireWriterLock(run.dir, 'codex workflow');

    const result = finalizeRevision(run.dir);

    await expect(result).rejects.toThrow(WriterLockHeldError);
    await writer.release();
  });

  it('should fail integrity for a tampered journal object', async () => {
    const run = await recordedRun();
    const result = await exportRun(run.dir);
    const files = readArchive(await readFile(result.archive));
    const object =
      [...files.keys()].find((file) => file.startsWith(objectPathPrefix)) ?? '';

    files.set(object, Buffer.from('tampered'));
    const verification = verifyBundle(
      readArchive(
        writeArchive(
          [...files].map(([file, bytes]) => ({ path: file, bytes })),
        ),
      ),
      'tampered',
    );

    expect(verification.checks[0]?.code).toBe('file_digest_mismatch');
  });
});

describe('export - exportRun() with every operation recorded', () => {
  // A journal whose writer observes every kind, with a succeeded probe
  // operation that returned each captured answer, as a local run records.
  const fullyRecordedRun = async ({ skipProbes = 0 } = {}) => {
    const run = await createSyntheticRun(path.join(root, 'run'));
    const recorder = await openRecorder(run.dir, {
      origin: 'local',
      runId: syntheticRunId,
      observes: recordedOperationKinds,
      ...syntheticDigests,
    });
    const inputs = await readRunInputs(run.dir);
    const trace = probeTraceOf(recorder, 'probe');

    for (const record of (inputs?.captured ?? []).slice(skipProbes)) {
      const attempt = await trace.start({
        sectionKey: record.sectionKey,
        surface: record.surface,
        promptId: record.promptId,
        promptText: record.promptText,
        runIndex: record.runIndex,
        attempt: 1,
        requestedModel: 'openai/gpt-5.4-mini',
      });

      await attempt.end({
        outcome: 'succeeded',
        text: record.probe.text,
        retrieval: null,
        requestedModel: 'openai/gpt-5.4-mini',
      });
    }

    return run;
  };

  const traceCoverageOf = async (dir: string) => {
    const result = await exportRun(dir);
    const source = await readBundleSource(result.archive);
    const verification = verifyBundle(source.files, source.description);

    return {
      result,
      source,
      check: verification.checks.find((item) => item.id === 'trace.coverage'),
    };
  };

  it('should declare coverage and pass it when a probe returned every captured answer', async () => {
    const run = await fullyRecordedRun();

    const { result, check } = await traceCoverageOf(run.dir);

    expect(result.manifest.trace.coverage).toBe('declared');
    expect(check?.outcome).toBe('pass');
  });

  it('should stay partial and name the gap when an answer was banked before the journal', async () => {
    const run = await fullyRecordedRun({ skipProbes: 1 });

    const { result, check } = await traceCoverageOf(run.dir);

    expect(result.manifest.trace.coverage).toBe('partial');
    expect(result.manifest.trace.limitations[0]).toMatch(
      /^1 of \d+ captured answers have no probe operation/,
    );
    expect(check?.code).toBe('trace_partial');
  });

  it('should stay partial when a writer observes only the workflow', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));

    await openRecorder(run.dir, {
      origin: 'hosted',
      runId: syntheticRunId,
      ...syntheticDigests,
    });

    const { result } = await traceCoverageOf(run.dir);

    expect(result.manifest.trace.coverage).toBe('partial');
    expect(result.manifest.trace.limitations[0]).toContain(
      'did not record probe, canary, research_tool, technical_check operations',
    );
  });

  it('should fail a declared coverage that the events do not support', async () => {
    const run = await fullyRecordedRun();
    const { result, source } = await traceCoverageOf(run.dir);
    const events = readJournal(
      source.files.get(bundlePaths.events)?.toString('utf8') ?? '',
    ).events;
    const inputs = await readRunInputs(run.dir);
    // Without the probe operations, nothing returned the captured answers.
    const withoutProbes = events.filter(
      (event) =>
        event.payload.kind !== 'probe' && event.type !== 'operation_finished',
    );

    const check = checkTraceCoverage(
      result.manifest,
      withoutProbes,
      inputs?.captured.map(capturedAnswerOf),
    );

    expect(check.outcome).toBe('fail');
    expect(check.code).toBe('trace_coverage_overstated');
  });
});
