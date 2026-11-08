import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as AiModule from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCaptureManifest } from './capture-manifest';
import { captureSectionProbes } from './pipeline';
import {
  aeoAuditConfigSchema,
  aeoEvidenceChunkSchema,
  aeoSnapshotSchema,
  type AeoEvidenceChunk,
} from './schema';
import { FileProbeStore } from './stores/files';
import type { CapturedUnitRecord } from './stores/ports';

// ============================================================================
// The golden replay (src/__fixtures__/replay/README.md): the probe bank of
// Literally.dev's 2026-09-04 self-audit, read through the file store as a
// resumed run reads it. Every planned unit of the committed config is
// satisfied from the bank and nothing is dispatched: the AI SDK, the network
// and the agent CLIs all fail if reached. The bank's answers then agree with
// the committed evidence chunks byte for byte, and its legacy rows (no
// `status`, no capture metadata) keep their manifest identity.
// ============================================================================

const provider = vi.hoisted(() => ({
  streamText: vi.fn(() => {
    throw new Error('The replay must not call a model.');
  }),
}));

vi.mock('ai', async () => ({
  ...(await vi.importActual<typeof AiModule>('ai')),
  streamText: provider.streamText,
}));

const replayDir = path.join(import.meta.dirname, '__fixtures__', 'replay');

const readFixture = async (relative: string): Promise<unknown> => {
  return JSON.parse(await readFile(path.join(replayDir, relative), 'utf8'));
};

// Recorded from 0.2.2: the manifest the bank and the evidence produce.
const pinnedManifestDigest =
  '919139e742cc35d4398543d2d86a4a7dbdf7a579f19b6576d96371bb36204fcc';

let bankDir: string;

beforeEach(async () => {
  bankDir = await mkdtemp(path.join(tmpdir(), 'aeo-replay-'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('The replay must not fetch.'))),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(bankDir, { recursive: true, force: true });
});

describe('pipeline - captureSectionProbes() golden replay', () => {
  it('should resume every planned unit of the self-audit from its bank, dispatching nothing', async () => {
    const config = aeoAuditConfigSchema.parse(
      await readFixture('literally-2026-q3/config.json'),
    );
    const snapshot = aeoSnapshotSchema.parse(
      await readFixture('literally-2026-q3/snapshot.json'),
    );
    const { surfaces, agentClis } = snapshot.meta;

    if (!surfaces || !agentClis) {
      throw new Error('The replay snapshot names no surfaces or CLIs.');
    }

    await copyFile(
      path.join(replayDir, 'literally-2026-q3.probes.jsonl'),
      path.join(bankDir, `${config.reportKey}.jsonl`),
    );
    const probeStore = await FileProbeStore.open(config.reportKey, {
      dir: bankDir,
    });
    const dispatched: string[] = [];
    const captures = [];

    for (const section of config.sections) {
      captures.push(
        await captureSectionProbes({
          sectionKey: section.key,
          brand: config.brand,
          competitors: section.competitors ?? config.competitors,
          prompts: section.prompts,
          geography: config.geography,
          language: config.language,
          surfaces,
          agentProbes: config.agentProbes,
          chatProbes: config.chatProbes,
          agentCliVersions: { ...agentClis, cursor: agentClis.cursor ?? null },
          runId: 'replay',
          probeStore,
          analysisStore: null,
          // No CLI can start: PATH is empty.
          agentRuntime: { env: { PATH: '' }, claudeConfigDir: null },
          trace: {
            start: (attempt) => {
              dispatched.push(`${attempt.surface}:${attempt.promptId}`);

              return Promise.reject(new Error('The replay must not probe.'));
            },
          },
          logContext: {},
        }),
      );
    }

    const evidence: AeoEvidenceChunk[] = [];

    for (const file of await readdir(
      path.join(replayDir, 'literally-2026-q3', 'evidence'),
    )) {
      evidence.push(
        aeoEvidenceChunkSchema.parse(
          await readFixture(path.join('literally-2026-q3', 'evidence', file)),
        ),
      );
    }

    const records = (await probeStore.list()).filter(
      (record): record is CapturedUnitRecord => record.status === 'captured',
    );
    // Throws when a banked answer or retrieval log differs from the
    // committed evidence of the same run.
    const manifest = buildCaptureManifest({
      reportKey: config.reportKey,
      runId: 'replay',
      createdAt: '2026-09-04T12:00:00.000Z',
      config,
      chunks: evidence,
      records,
      surfaces,
    });

    expect(dispatched).toEqual([]);
    expect(provider.streamText).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      captures.flatMap((capture) =>
        capture.coverage.filter((entry) => entry.captured !== entry.planned),
      ),
    ).toEqual([]);
    expect(captures.flatMap((capture) => capture.unitFailures)).toEqual([]);
    expect(captures.flatMap((capture) => capture.lostPromptIds)).toEqual([]);
    expect(
      captures.reduce((count, capture) => count + capture.probes.length, 0),
    ).toBe(snapshot.meta.probeCount);
    expect(manifest.captures).toHaveLength(snapshot.meta.probeCount);
    expect(manifest.captures.every((capture) => capture.hasEvidence)).toBe(
      true,
    );
    expect(
      new Set(manifest.captures.map((capture) => capture.metadataProvenance)),
    ).toEqual(new Set(['legacy_preserved_record']));
    expect(manifest.digest).toBe(pinnedManifestDigest);
  });
});
