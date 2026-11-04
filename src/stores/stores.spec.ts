import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ProbeUnit } from '../lib/checkpoint';
import type { ProbeResult } from '../probes/probes';
import { aeoSnapshotVersion, type AeoSnapshot } from '../schema';
import { FileAnalysisStore, FileProbeStore, FileReportStore } from './files';
import { MemoryAnalysisStore, MemoryProbeStore } from './memory';
import {
  UnitConflictError,
  type AnalysisStore,
  type CapturedUnitRecord,
  type FailedUnitRecord,
  type ProbeStore,
} from './ports';

// ============================================================================
// Storage port contract (hardening spec §4.4): the same assertions run over
// the in-memory and the file backends, so a test that passes on one and not
// the other is a backend bug, not a contract ambiguity.
// ============================================================================

const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => {
  return {
    promptId: 'p1',
    promptText: 'What are the best tools?',
    promptCategory: 'comparison',
    modelName: 'claude',
    runIndex: 1,
    text: 'Answer text',
    ...overrides,
  };
};

const unit = (overrides: Partial<ProbeUnit> = {}): ProbeUnit => {
  return {
    sectionKey: 'section_a',
    promptId: 'p1',
    promptText: 'What are the best tools?',
    surface: 'claude',
    runIndex: 1,
    ...overrides,
  };
};

const captured = (
  overrides: Partial<ProbeUnit> = {},
  text = 'Answer text',
): CapturedUnitRecord => {
  const probeUnit = unit(overrides);

  return {
    status: 'captured',
    ...probeUnit,
    capturedAt: '2026-09-06T10:00:00.000Z',
    probe: probe({
      promptId: probeUnit.promptId,
      promptText: probeUnit.promptText,
      modelName: probeUnit.surface,
      runIndex: probeUnit.runIndex,
      text,
    }),
  };
};

const failed = (overrides: Partial<ProbeUnit> = {}): FailedUnitRecord => {
  return {
    status: 'failed',
    ...unit(overrides),
    failedAt: '2026-09-06T10:00:00.000Z',
    kind: 'capacity',
    attempts: 3,
    lastError: 'exit 1, stderr: overloaded',
  };
};

type Backend = {
  name: string;
  openProbes: () => Promise<ProbeStore>;
  openAnalyses: () => Promise<AnalysisStore>;
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aeo-stores-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const backends: Backend[] = [
  {
    name: 'memory',
    openProbes: () => Promise.resolve(new MemoryProbeStore()),
    openAnalyses: () => Promise.resolve(new MemoryAnalysisStore()),
  },
  {
    name: 'file',
    openProbes: () => FileProbeStore.open('report', { dir }),
    openAnalyses: () => FileAnalysisStore.open('report', { dir }),
  },
];

describe.each(backends)('stores - ProbeStore contract ($name)', (backend) => {
  it('should start empty', async () => {
    const store = await backend.openProbes();

    expect(await store.get(unit())).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('should round-trip a captured record', async () => {
    const store = await backend.openProbes();

    await store.put(captured());

    const hit = await store.get(unit());

    expect(hit?.status).toBe('captured');
    expect(hit?.status === 'captured' && hit.probe.text).toBe('Answer text');
  });

  it('should miss when the prompt text was edited (baseline reset semantics)', async () => {
    const store = await backend.openProbes();

    await store.put(captured());
    expect(await store.get(unit({ promptText: 'Edited prompt' }))).toBeNull();
  });

  it('should key by section, surface, prompt, and run index', async () => {
    const store = await backend.openProbes();

    await store.put(captured());
    expect(await store.get(unit({ runIndex: 2 }))).toBeNull();
    expect(await store.get(unit({ sectionKey: 'section_b' }))).toBeNull();
    expect(await store.get(unit({ surface: 'chatgpt' }))).toBeNull();
  });

  it('should refuse a second capture of the same unit (redelivery, §4.2)', async () => {
    const store = await backend.openProbes();

    await store.put(captured({}, 'first'));
    await expect(store.put(captured({}, 'second'))).rejects.toBeInstanceOf(
      UnitConflictError,
    );

    const hit = await store.get(unit());

    expect(hit?.status === 'captured' && hit.probe.text).toBe('first');
  });

  it('should store failed units, let a capture replace them, and let a failure update them', async () => {
    const store = await backend.openProbes();

    await store.put(failed());
    expect((await store.get(unit()))?.status).toBe('failed');
    await store.put({ ...failed(), attempts: 4 });

    const updated = await store.get(unit());

    expect(updated?.status === 'failed' && updated.attempts).toBe(4);
    await store.put(captured());
    expect((await store.get(unit()))?.status).toBe('captured');
    // A failed record never replaces a capture.
    await store.put(failed());
    expect((await store.get(unit()))?.status).toBe('captured');
  });

  it('should invalidate by surface across sections and by section:surface pair', async () => {
    const store = await backend.openProbes();

    await store.put(captured());
    await store.put(captured({ sectionKey: 'section_b' }));
    await store.put(captured({ surface: 'chatgpt' }));

    expect(await store.invalidate({ surface: 'codex' })).toBe(0);
    expect(
      await store.invalidate({ sectionKey: 'section_b', surface: 'claude' }),
    ).toBe(1);
    expect(await store.get(unit({ sectionKey: 'section_b' }))).toBeNull();
    expect(await store.invalidate({ surface: 'claude' })).toBe(1);
    expect(await store.get(unit())).toBeNull();
    expect((await store.get(unit({ surface: 'chatgpt' })))?.status).toBe(
      'captured',
    );
    expect(await store.invalidate({})).toBe(1);
    expect(await store.list()).toEqual([]);
  });
});

describe('files - FileProbeStore', () => {
  it('should persist across reopen, drop a torn tail line, and read legacy lines without status', async () => {
    const store = await FileProbeStore.open('report', { dir });

    await store.put(captured());

    // A line written before unit outcomes existed: no `status` field.
    const { status: _status, ...legacy } = captured({ surface: 'chatgpt' });

    await appendFile(
      path.join(dir, 'report.jsonl'),
      `${JSON.stringify(legacy)}\n{"truncated`,
      'utf8',
    );

    const reopened = await FileProbeStore.open('report', { dir });

    expect(reopened.size).toBe(2);
    expect((await reopened.get(unit({ surface: 'chatgpt' })))?.status).toBe(
      'captured',
    );
  });

  it('should scope reports to their own files and persist invalidation', async () => {
    const a = await FileProbeStore.open('report-a', { dir });

    await a.put(captured());

    const b = await FileProbeStore.open('report-b', { dir });

    expect(b.size).toBe(0);
    await a.invalidate({ surface: 'claude' });
    expect((await FileProbeStore.open('report-a', { dir })).size).toBe(0);
  });

  it('should patch matching records in place with rewriteRecords and persist them', async () => {
    const store = await FileProbeStore.open('report', { dir });

    await store.put(captured());
    await store.put(captured({ surface: 'chatgpt' }));

    const changed = await store.rewriteRecords((record) =>
      record.status === 'captured' && record.surface === 'claude'
        ? { ...record, probe: { ...record.probe, text: 'patched' } }
        : null,
    );

    expect(changed).toBe(1);

    const reopened = await FileProbeStore.open('report', { dir });
    const hit = await reopened.get(unit());

    expect(hit?.status === 'captured' && hit.probe.text).toBe('patched');
    expect(reopened.size).toBe(2);
  });

  it('should reject a write it cannot persist instead of swallowing it', async () => {
    const store = await FileProbeStore.open('report', {
      dir: path.join(dir, 'blocked'),
    });

    // A file where the directory should be makes the append fail.
    await appendFile(path.join(dir, 'blocked'), '', 'utf8');
    await expect(store.put(captured())).rejects.toThrow();
  });
});

const valueSchema = z.object({ answer: z.string() });

describe('files - FileAnalysisStore permissions', () => {
  it('should keep new and existing analysis checkpoints private while preserving their values', async () => {
    const store = await FileAnalysisStore.open('private-report', { dir });
    const filename = path.join(dir, 'private-report.analysis.jsonl');

    await store.put('first', { answer: 'private source' });
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    await chmod(filename, 0o644);
    await chmod(dir, 0o755);
    await store.put('second', { answer: 'untrusted diagnostic' });
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    const reopened = await FileAnalysisStore.open('private-report', { dir });

    expect(await reopened.get('first', valueSchema)).toEqual({
      answer: 'private source',
    });
    expect(await reopened.get('second', valueSchema)).toEqual({
      answer: 'untrusted diagnostic',
    });
  });
});

describe.each(backends)(
  'stores - AnalysisStore contract ($name)',
  (backend) => {
    it('should round-trip a value, treat an invalid stored value as a miss, and clear', async () => {
      const store = await backend.openAnalyses();

      expect(await store.get('k', valueSchema)).toBeNull();
      await store.put('k', { answer: 'yes' }, { runId: 'r1', version: 2 });
      expect(await store.get('k', valueSchema)).toEqual({ answer: 'yes' });
      expect(await store.get('k', z.object({ other: z.number() }))).toBeNull();
      expect(await store.count()).toBe(1);
      expect(await store.clear()).toBe(1);
      expect(await store.get('k', valueSchema)).toBeNull();
    });

    it('should let the last write win', async () => {
      const store = await backend.openAnalyses();

      await store.put('k', { answer: 'old' });
      await store.put('k', { answer: 'new' });
      expect(await store.get('k', valueSchema)).toEqual({ answer: 'new' });
    });
  },
);

describe('files - FileAnalysisStore', () => {
  it('should persist across reopen and remove the file on clear', async () => {
    const store = await FileAnalysisStore.open('report', { dir });

    await store.put('k', { answer: 'yes' });

    const reopened = await FileAnalysisStore.open('report', { dir });

    expect(await reopened.get('k', valueSchema)).toEqual({ answer: 'yes' });
    await reopened.clear();
    expect(
      await (await FileAnalysisStore.open('report', { dir })).count(),
    ).toBe(0);
  });
});

const snapshot = (reportKey: string): AeoSnapshot => {
  return {
    version: aeoSnapshotVersion,
    reportKey,
    brand: { name: 'Brand', domain: 'brand.example', aliases: [] },
    competitors: [{ name: 'Rival', domain: 'rival.example', aliases: [] }],
    sections: [
      {
        key: 'main',
        visibility: {
          prompts: [{ text: 'Best tools?', category: 'comparison' }],
          surfaces: ['claude'],
          matrix: [
            {
              promptIdx: 0,
              surface: 'claude',
              prospectMentioned: false,
              prospectPosition: 'absent',
              contextSnippet: null,
              runIndex: 1,
              competitors: [{ domain: 'rival.example', mentioned: false }],
              evidenceFile: 'evidence/main-0.json',
            },
          ],
          summary: {
            prospectShareOfVoice: 0,
            prospectCitationRate: 0,
            agentShareOfVoice: null,
            agentCitationRate: null,
            byModel: { claude: { shareOfVoice: 0, citationRate: 0 } },
            byCompetitor: [],
            topCompetitorDomain: null,
          },
        },
      },
    ],
    meta: {
      generatedAt: '2026-09-06T10:00:00.000Z',
      promptCount: 1,
      probeCount: 1,
      partialFailures: [],
    },
  };
};

describe('files - FileReportStore', () => {
  it('should store immutable run artifacts without publishing them and bind snapshots to their key', async () => {
    const store = new FileReportStore(dir);

    expect(await store.listReportKeys()).toEqual([]);
    expect(await store.readSnapshot('r1')).toBeNull();
    await store.writeReport('r1', 'run-1', {
      snapshot: snapshot('r1'),
      labels: { version: 1, model: 'm', entries: {} },
      chunks: [
        {
          sectionKey: 'main',
          promptIdx: 0,
          promptText: 'Best tools?',
          runs: [],
        },
      ],
      fullScope: true,
    });
    expect(await store.listReportKeys()).toEqual([]);
    expect(await store.readSnapshot('r1')).toBeNull();
    expect((await store.readSnapshot('r1', 'run-1'))?.reportKey).toBe('r1');
    expect((await store.readLabels('r1', 'run-1'))?.version).toBe(1);
    expect(
      (await store.readEvidenceChunk('r1', 'run-1', 'evidence/main-0.json'))
        .promptText,
    ).toBe('Best tools?');
    // No temp directory left behind.
    expect(await store.listReportKeys()).toEqual([]);

    // A snapshot stored under the wrong key is a defect, never served.
    await expect(
      store.writeReport('r2', 'run-2', {
        snapshot: snapshot('r1'),
        labels: { version: 1, model: 'm', entries: {} },
        chunks: [],
        fullScope: true,
      }),
    ).rejects.toThrow(/belongs to/);
  });

  it('should retain the legacy file reader and relabel path during migration', async () => {
    const store = new FileReportStore(dir);

    await mkdir(path.join(dir, 'r1'), { recursive: true });
    await writeFile(
      path.join(dir, 'r1', 'snapshot.json'),
      JSON.stringify(snapshot('r1')),
    );
    await store.rewriteReport('r1', {
      snapshot: {
        ...snapshot('r1'),
        meta: { ...snapshot('r1').meta, probeCount: 7 },
      },
      labels: { version: 1, model: 'm', entries: {} },
    });
    expect((await store.readSnapshot('r1'))?.meta.probeCount).toBe(7);
    expect(
      await readFile(path.join(dir, 'r1', 'snapshot.json'), 'utf8'),
    ).toMatch(/"probeCount": 7/);
  });
});
