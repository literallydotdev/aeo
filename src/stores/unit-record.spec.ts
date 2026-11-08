import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureForRun } from '../codex-workflow/capture';
import { unlimited } from '../probes/limits';
import { planRun } from '../runner';
import { aeoAuditConfigSchema, runRequestSchema } from '../schema';
import { FileProbeStore } from './files';
import { memoryStores } from './memory';
import type { ProbeStore, UnitRecord } from './ports';
import { parseUnitRecord, ProbeStoreIntegrityError } from './unit-record';

// ============================================================================
// Probe store rows validated on read (probe adapters spec §7, phase 3 item
// 6): every shape a release wrote is accepted as it was written; a row no
// release could have written stops the run before any dispatch, and is
// never read as a missing unit to probe again.
// ============================================================================

const legacyRow = {
  sectionKey: 'file_stores',
  promptId: 'fs1',
  promptText: 'Which managed file store suits a small team?',
  surface: 'chatgpt',
  runIndex: 1,
  capturedAt: '2026-08-22T10:00:00.000Z',
  probe: {
    promptId: 'fs1',
    promptText: 'Which managed file store suits a small team?',
    promptCategory: 'product_recommendation',
    modelName: 'chatgpt',
    runIndex: 1,
    text: 'Acme Files.',
  },
};

const agentRow = {
  ...legacyRow,
  status: 'captured',
  surface: 'codex',
  runId: 'run-1',
  probe: {
    ...legacyRow.probe,
    modelName: 'codex',
    usedWebSearch: null,
    agentCliVersion: 'codex-cli 0.150.1',
    requestedModel: null,
  },
  captureMetadata: {
    requestedModel: null,
    reportedModel: null,
    parameters: { geography: 'us', language: 'en' },
  },
};

describe('unit-record - parseUnitRecord()', () => {
  it('should accept a row from before unit outcomes, capture metadata and retrieval logs, keeping it as written', () => {
    const record = parseUnitRecord(legacyRow, 'line 1');

    expect(record).toEqual({ ...legacyRow, status: 'captured' });
    // The stored bytes are kept: status is appended, nothing reordered.
    expect(JSON.stringify(record)).toBe(
      JSON.stringify({ ...legacyRow, status: 'captured' }),
    );
  });

  it('should accept a coding-agent row and a failed row', () => {
    expect(parseUnitRecord(agentRow, 'line 1')).toBe(agentRow);
    expect(
      parseUnitRecord(
        {
          status: 'failed',
          sectionKey: 'file_stores',
          promptId: 'fs1',
          promptText: 'Which managed file store suits a small team?',
          surface: 'gemini',
          runIndex: 2,
          failedAt: '2026-09-06T10:00:00.000Z',
          kind: 'capacity',
          attempts: 3,
          lastError: 'Too many requests',
        },
        'line 2',
      ),
    ).toMatchObject({ status: 'failed', kind: 'capacity' });
  });

  it.each([
    ['an answer that is not text', { probe: { ...legacyRow.probe, text: 3 } }],
    ['an unknown field', { answer: 'Acme Files.' }],
    ['a probe of another surface', { surface: 'gemini' }],
    [
      'a coding-agent probe without its CLI version',
      {
        surface: 'codex',
        probe: { ...legacyRow.probe, modelName: 'codex', usedWebSearch: true },
      },
    ],
  ])('should refuse a row with %s, naming the row', (_case, change) => {
    expect(() =>
      parseUnitRecord({ ...legacyRow, ...change }, 'line 7'),
    ).toThrow(/Probe store row line 7 is invalid/);
  });
});

describe('files - FileProbeStore.open()', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aeo-unit-record-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('should refuse a store with an invalid row instead of reading the unit as missing', async () => {
    const malformed = { ...legacyRow, probe: { ...legacyRow.probe, text: 3 } };

    await writeFile(
      path.join(dir, 'report.jsonl'),
      `${JSON.stringify(legacyRow)}\n${JSON.stringify(malformed)}\n`,
    );

    const opened = FileProbeStore.open('report', { dir });

    await expect(opened).rejects.toBeInstanceOf(ProbeStoreIntegrityError);
    await expect(opened).rejects.toThrow(/report\.jsonl:2/);
  });

  it('should cut an unterminated last line, so the next append is read back', async () => {
    const file = path.join(dir, 'report.jsonl');

    await writeFile(file, `${JSON.stringify(legacyRow)}\n`);
    await appendFile(file, '{"sectionKey":"file_st');

    const store = await FileProbeStore.open('report', { dir });

    await store.put({ ...agentRow, status: 'captured' } as UnitRecord);

    const reopened = await FileProbeStore.open('report', { dir });

    expect(reopened.size).toBe(2);
    expect(await readFile(file, 'utf8')).not.toContain('file_st"');
  });
});

describe('capture - captureForRun()', () => {
  it('should stop before any section dispatches when a banked row is invalid', async () => {
    const config = aeoAuditConfigSchema.parse({
      reportKey: 'unit-record',
      slug: 'unit-record-abcde',
      brand: { name: 'Acme Files', domain: 'acme.example', aliases: [] },
      competitors: [{ name: 'Rival Files', domain: 'rival.example' }],
      sections: [
        {
          key: 'file_stores',
          prompts: [
            { id: 'fs1', text: 'Which store?', category: 'comparison' },
          ],
        },
      ],
      moneyPages: [],
      productBrief: 'A fictional file store used only in tests.',
    });
    const request = runRequestSchema.parse({
      reportKey: 'unit-record',
      runId: 'run-2',
      surfaces: ['chatgpt'],
    });
    // A database row whose stored probe payload no release could write.
    const malformed = {
      ...legacyRow,
      status: 'captured',
      probe: { ...legacyRow.probe, text: 3 },
    } as unknown as UnitRecord;
    const probeStore: ProbeStore = {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
      invalidate: () => Promise.resolve(0),
      list: () => Promise.resolve([malformed]),
    };
    const captureSection = vi.fn();

    const capture = captureForRun({
      config,
      request,
      plan: planRun(config, request),
      stores: { ...memoryStores(), probeStore },
      agentCliVersions: { claudeCode: null, codex: null, cursor: null },
      limiter: unlimited(),
      logContext: {},
      captureSection,
    });

    await expect(capture).rejects.toBeInstanceOf(ProbeStoreIntegrityError);
    expect(captureSection).not.toHaveBeenCalled();
  });
});
