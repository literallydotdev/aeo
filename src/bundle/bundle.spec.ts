import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { resolveRunBindings } from '../engine/run-bindings';
import { canonicalJson, strictCanonicalJson } from '../lib/canonical-json';
import { defaultProbeBindings } from '../probes/bindings';
import { aeoVisibilitySchema } from '../report/core/schema';
import {
  bundleManifestSchema,
  bundlePaths,
  calculationVersion,
  digestManifest,
  objectPathPrefix,
  type BundleManifest,
} from './contracts';
import {
  ExportBlockedError,
  exportRun,
  finalizeRevision,
  readFinalizedRevisions,
} from './export';
import { buildEvent, openJournal, putObject, readJournal } from './journal';
import { encodeBundleJson, parseBundleJson, sha256Hex } from './json';
import { bundlePathError } from './paths';
import { readBundleSource } from './read';
import { verifyBundle, type Verification } from './verify';
import { BundleRefusedError, readArchive, writeArchive } from './zip';
import {
  createSyntheticRun,
  oddSectionKey,
} from './__fixtures__/synthetic-run';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-bundle-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const outcomeOf = (verification: Verification, id: string) => {
  return verification.checks.find((check) => check.id === id);
};

const exportSynthetic = async () => {
  const run = await createSyntheticRun(path.join(root, 'run'));
  const result = await exportRun(run.dir);
  const files = readArchive(await readFile(result.archive));

  return { run, result, files };
};

/** Rewrites one document and re-signs the inventory and manifest, as a
 * producer forging a consistent bundle would. */
const forge = (
  files: ReadonlyMap<string, Buffer>,
  changes: ReadonlyMap<string, Buffer | undefined>,
): Map<string, Buffer> => {
  const forged = new Map(files);

  for (const [file, bytes] of changes) {
    if (bytes === undefined) {
      forged.delete(file);
    } else {
      forged.set(file, bytes);
    }
  }

  const manifest = bundleManifestSchema.parse(
    parseBundleJson(
      (forged.get(bundlePaths.manifest) ?? Buffer.alloc(0)).toString('utf8'),
    ),
  );
  const { bundleDigest: _bundleDigest, ...unsigned } = manifest;
  const resigned: Omit<BundleManifest, 'bundleDigest'> = {
    ...unsigned,
    files: [...forged.entries()]
      .filter(([file]) => file !== bundlePaths.manifest)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([file, bytes]) => ({
        path: file,
        bytes: bytes.length,
        mediaType: file.endsWith('.jsonl')
          ? 'application/x-ndjson'
          : 'application/json',
        sha256: sha256Hex(bytes),
      })),
  };

  forged.set(
    bundlePaths.manifest,
    encodeBundleJson({ ...resigned, bundleDigest: digestManifest(resigned) }),
  );

  return forged;
};

const editJson = (
  files: ReadonlyMap<string, Buffer>,
  file: string,
  edit: (value: unknown) => unknown,
): Buffer => {
  const value = parseBundleJson(
    (files.get(file) ?? Buffer.alloc(0)).toString('utf8'),
  );

  return encodeBundleJson(edit(value));
};

describe('canonical-json - strictCanonicalJson()', () => {
  it('should produce the same bytes as canonicalJson on valid JSON', () => {
    const vectors: unknown[] = [
      { b: 1, a: [true, null, 'x'], é: { z: 1.5, y: -0 } },
      [1e21, 0.1, 'line\nbreak', { '': 0 }],
      'plain',
      { emoji: '😀', b: 'B', a: 'a', A: 'A' },
    ];

    for (const vector of vectors) {
      expect(strictCanonicalJson(vector)).toBe(canonicalJson(vector));
    }
  });

  it('should sort keys by UTF-16 code units', () => {
    const result = strictCanonicalJson({
      'b': 1,
      'B': 2,
      'a': 3,
      '😀': 4,
      'ｚ': 5,
    });

    // 😀 is the surrogate pair D83D DE00, below ｚ (FF5A) by code unit even
    // though its code point is higher: the order is UTF-16, not Unicode.
    expect(result).toBe('{"B":2,"a":3,"b":1,"😀":4,"ｚ":5}');
  });

  it('should refuse what canonicalJson silently rewrites', () => {
    expect(() => strictCanonicalJson({ value: Number.NaN })).toThrow(
      /Non-finite/,
    );
    expect(() => strictCanonicalJson([1, undefined])).toThrow(
      /Undefined array element/,
    );
    expect(() => strictCanonicalJson({ at: new Date(0) })).toThrow(
      /Non-plain object/,
    );
  });
});

describe('json - parseBundleJson()', () => {
  it('should refuse a duplicate key at any depth', () => {
    expect(() => parseBundleJson('{"a":1,"a":2}')).toThrow(
      /Duplicate JSON key/,
    );
    expect(() => parseBundleJson('[{"x":{"k":1,"k":1}}]')).toThrow(
      /Duplicate JSON key/,
    );
  });

  it('should parse keys that only look alike', () => {
    const result = parseBundleJson('{"a":1,"\\u0061b":2,"A":3}');

    expect(result).toEqual({ a: 1, ab: 2, A: 3 });
  });
});

describe('paths - bundlePathError()', () => {
  it('should refuse traversal, absolute, uppercase and non-ASCII paths', () => {
    expect(bundlePathError('../escape.json')).toBeDefined();
    expect(bundlePathError('/abs.json')).toBeDefined();
    expect(bundlePathError('report/Snapshot.json')).toBeDefined();
    expect(bundlePathError('report/märkte.json')).toBeDefined();
    expect(bundlePathError('report/snapshot.json')).toBeUndefined();
  });
});

describe('journal - putObject()', () => {
  it('should store the same bytes written concurrently once, without a failed write', async () => {
    const writes = Array.from({ length: 5 }, () =>
      putObject(root, '{"domain":"acme.example"}'),
    );

    const digests = await Promise.all(writes);

    expect(new Set(digests).size).toBe(1);
    expect(
      await readFile(
        path.join(root, objectPathPrefix, digests[0] ?? ''),
        'utf8',
      ),
    ).toBe('{"domain":"acme.example"}');
  });
});

describe('journal - openJournal()', () => {
  it('should chain appended events and detect an edited line', async () => {
    const journal = await openJournal(root);

    await journal.append({ type: 'run_started' });
    await journal.append({ type: 'plan_frozen', payload: { units: 3 } });

    const text = await readFile(path.join(root, 'events.jsonl'), 'utf8');
    const edited = text.replace('"units":3', '"units":4');

    expect(readJournal(text).errors).toEqual([]);
    expect(readJournal(edited).errors[0]).toMatch(
      /does not match its own digest/,
    );
  });

  it('should quarantine a torn final append and record the interruption', async () => {
    const journal = await openJournal(root);

    await journal.append({ type: 'run_started' });
    await writeFile(path.join(root, 'events.jsonl'), '{"seq":1,"id":', {
      flag: 'a',
    });

    const reopened = await openJournal(root);
    const reading = readJournal(
      await readFile(path.join(root, 'events.jsonl'), 'utf8'),
    );

    expect(reopened.head().count).toBe(2);
    expect(reading.errors).toEqual([]);
    expect(reading.events[1]?.type).toBe('run_interrupted');
  });
});

describe('zip - readArchive()', () => {
  it('should round-trip deterministic archives', () => {
    const entries = [
      { path: 'b.json', bytes: Buffer.from('{}') },
      { path: 'a/c.json', bytes: Buffer.from('[1]') },
    ];

    const first = writeArchive(entries);
    const second = writeArchive([...entries].reverse());

    expect(first.equals(second)).toBe(true);
    expect(readArchive(first).get('a/c.json')?.toString()).toBe('[1]');
  });

  it('should refuse a traversal entry, a duplicate entry and garbage', () => {
    const traversal = writeArchive([
      { path: 'ok.json', bytes: Buffer.from('{}') },
    ]);
    // Same length as ok.json, so only the name changes.
    const escaped = Buffer.from(
      traversal.toString('latin1').replaceAll('ok.json', '../a.js'),
      'latin1',
    );
    const duplicate = Buffer.from(
      writeArchive([
        { path: 'aa.json', bytes: Buffer.from('{}') },
        { path: 'ab.json', bytes: Buffer.from('{}') },
      ])
        .toString('latin1')
        .replaceAll('ab.json', 'aa.json'),
      'latin1',
    );

    expect(() => readArchive(escaped)).toThrow(BundleRefusedError);
    expect(() => readArchive(duplicate)).toThrow(/appears twice/);
    expect(() =>
      readArchive(Buffer.from('not a zip file at all, really')),
    ).toThrow(/end-of-directory/);
  });

  it('should refuse an archive over the size limits', () => {
    const archive = writeArchive([
      { path: 'big.json', bytes: Buffer.alloc(4096) },
    ]);

    const result = () =>
      readArchive(archive, {
        maxEntries: 10,
        maxEntryBytes: 1024,
        maxTotalBytes: 1024,
      });

    expect(result).toThrow(/size limits/);
  });
});

describe('export - exportRun()', () => {
  it('should verify a synthetic export offline with only its declared limitations', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = await exportSynthetic();

    const source = await readBundleSource(result.archive);
    const verification = verifyBundle(source.files, source.description);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(verification.exitCode).toBe(3);
    expect(outcomeOf(verification, 'bundle.integrity')?.outcome).toBe('pass');
    expect(outcomeOf(verification, 'trace.chain')?.outcome).toBe('pass');
    expect(outcomeOf(verification, 'trace.coverage')?.code).toBe(
      'trace_absent',
    );
    expect(outcomeOf(verification, 'plan.accounted')?.outcome).toBe('pass');
    expect(outcomeOf(verification, 'judgments.evidence')?.outcome).toBe('pass');
    expect(outcomeOf(verification, 'metrics.recomputed')?.outcome).toBe('pass');
    expect(verification.bundle?.origin).toBe('legacy_import');
    expect(verification.bundle?.captureAuthenticity).toBe('self_reported');
    expect(verification.disclosures.unjudgedAnswers).toBe(1);
  });

  it('should keep the bundle digest and archive bytes when re-exported', async () => {
    const { run, result } = await exportSynthetic();

    const again = await exportRun(run.dir, {
      output: path.join(root, 'again.aeo.zip'),
    });

    expect(again.reusedRevision).toBe(true);
    expect(again.manifest.bundleDigest).toBe(result.manifest.bundleDigest);
    expect(again.archiveSha256).toBe(result.archiveSha256);
  });

  it('should finalize a descendant revision when the working state changed', async () => {
    const { run, result } = await exportSynthetic();

    await writeFile(
      path.join(run.dir, 'SCORECARD.json'),
      JSON.stringify({ version: 1 }),
    );
    const next = await finalizeRevision(run.dir);

    expect(next.reused).toBe(false);
    expect(next.manifest.revision.predecessor).toEqual({
      id: result.manifest.revision.id,
      bundleDigest: result.manifest.bundleDigest,
    });
    expect(next.manifest.run.measurementId).toBe(
      result.manifest.run.measurementId,
    );
  });

  it('should NOT overwrite an existing archive', async () => {
    const { run, result } = await exportSynthetic();

    const repeat = exportRun(run.dir, { output: result.archive });

    await expect(repeat).rejects.toThrow(ExportBlockedError);
  });

  it('should keep every bundle path restricted for a section key with / and non-ASCII', async () => {
    const { result, files } = await exportSynthetic();

    const config = parseBundleJson(
      (files.get(bundlePaths.config) ?? Buffer.alloc(0)).toString('utf8'),
    );

    expect(JSON.stringify(config)).toContain(oddSectionKey);
    expect(
      [...files.keys()].every((file) => bundlePathError(file) === undefined),
    ).toBe(true);
    expect(result.manifest.files.length).toBeGreaterThan(0);
  });

  it('should block an export that contains one of the run credentials', async () => {
    const secret = 'gw_live_0123456789abcdefTEST';
    const run = await createSyntheticRun(path.join(root, 'run'), {
      answerOverride: `Use the key ${secret} to sign in.`,
    });

    const result = exportRun(run.dir, {
      secrets: [secret],
      acceptFindings: true,
    });

    await expect(result).rejects.toThrow(/run's own credentials/);
  });

  it('should block a credential pattern until the findings are accepted', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'), {
      answerOverride:
        'Connect with postgres://user:pass@localhost/db as in the docs.',
    });

    const blocked = exportRun(run.dir);

    await expect(blocked).rejects.toThrow(/--accept-findings/);

    const accepted = await exportRun(run.dir, { acceptFindings: true });

    expect(accepted.manifest.acceptedFindings).toContainEqual({
      path: bundlePaths.captures,
      kind: 'credential_pattern',
    });
  });
});

describe('verify - verifyBundle()', () => {
  it('should fail integrity for a mutated file', async () => {
    const { files } = await exportSynthetic();
    const mutated = new Map(files);

    mutated.set(
      bundlePaths.analyze,
      Buffer.from(`${files.get(bundlePaths.analyze)?.toString()} `),
    );
    const verification = verifyBundle(mutated, 'mutated');

    expect(verification.exitCode).toBe(1);
    expect(outcomeOf(verification, 'bundle.integrity')?.code).toBe(
      'file_digest_mismatch',
    );
  });

  it('should fail integrity for an uninventoried file', async () => {
    const { files } = await exportSynthetic();
    const extra = new Map(files);

    extra.set('report/extra.json', Buffer.from('{}'));
    const verification = verifyBundle(extra, 'extra');

    expect(outcomeOf(verification, 'bundle.integrity')?.code).toBe(
      'file_uninventoried',
    );
  });

  it('should fail the recompute for a forged count in a re-signed bundle', async () => {
    const { files } = await exportSynthetic();
    const forged = forge(
      files,
      new Map([
        [
          bundlePaths.aggregate,
          editJson(files, bundlePaths.aggregate, (value) => {
            const text = JSON.stringify(value).replace(
              /"prospectShareOfVoice":[0-9.]+/,
              '"prospectShareOfVoice":0.99',
            );

            return JSON.parse(text);
          }),
        ],
      ]),
    );

    const verification = verifyBundle(forged, 'forged');

    expect(outcomeOf(verification, 'bundle.integrity')?.outcome).toBe('pass');
    expect(outcomeOf(verification, 'metrics.recomputed')?.code).toBe(
      'section_metrics_mismatch',
    );
  });

  it('should fail plan accounting for an omitted slot in a re-signed bundle', async () => {
    const { files } = await exportSynthetic();
    const forged = forge(
      files,
      new Map([
        [
          bundlePaths.captures,
          editJson(files, bundlePaths.captures, (value) =>
            Array.isArray(value) ? value.slice(1) : value,
          ),
        ],
      ]),
    );

    const verification = verifyBundle(forged, 'omitted');

    expect(outcomeOf(verification, 'plan.accounted')?.code).toBe(
      'coverage_count_mismatch',
    );
  });

  it('should fail evidence for a quote that is not verbatim', async () => {
    const { files } = await exportSynthetic();
    const forged = forge(
      files,
      new Map([
        [
          bundlePaths.qualify,
          editJson(files, bundlePaths.qualify, (value) =>
            JSON.parse(
              JSON.stringify(value).replace(
                '"quote":"Rivalstack"',
                '"quote":"Rivalstack is the best"',
              ),
            ),
          ),
        ],
      ]),
    );

    const verification = verifyBundle(forged, 'quote');

    expect(outcomeOf(verification, 'judgments.evidence')?.code).toBe(
      'quote_not_verbatim',
    );
  });

  it('should fail the chain for an event that references a missing object', async () => {
    const { files } = await exportSynthetic();
    const event = buildEvent(
      { type: 'run_started', objects: ['a'.repeat(64)] },
      { count: 0, digest: null },
      '2026-11-01T10:00:00.000Z',
    );
    const withEvent = forge(
      files,
      new Map([
        [bundlePaths.events, Buffer.from(`${JSON.stringify(event)}\n`)],
      ]),
    );
    const manifest = bundleManifestSchema.parse(
      parseBundleJson(
        (withEvent.get(bundlePaths.manifest) ?? Buffer.alloc(0)).toString(
          'utf8',
        ),
      ),
    );
    const { bundleDigest: _bundleDigest, ...unsigned } = manifest;
    const counted = { ...unsigned, events: { count: 1, head: event.digest } };

    withEvent.set(
      bundlePaths.manifest,
      encodeBundleJson({ ...counted, bundleDigest: digestManifest(counted) }),
    );
    const verification = verifyBundle(withEvent, 'stale');

    expect(outcomeOf(verification, 'trace.chain')?.code).toBe('object_missing');
  });

  it('should report an unknown bundle version as unsupported', async () => {
    const { files } = await exportSynthetic();
    const future = new Map(files);

    future.set(
      bundlePaths.manifest,
      editJson(files, bundlePaths.manifest, (value) => ({
        ...(value as Record<string, unknown>),
        bundleSchemaVersion: 99,
      })),
    );
    const verification = verifyBundle(future, 'future');

    expect(verification.exitCode).toBe(2);
    expect(verification.checks[0]?.code).toBe('bundle_version_unsupported');
  });

  it('should verify a version 1 bundle as it verifies the version 2 bundles it writes', async () => {
    const { files } = await exportSynthetic();
    const manifest = bundleManifestSchema.parse(
      parseBundleJson(
        (files.get(bundlePaths.manifest) ?? Buffer.alloc(0)).toString('utf8'),
      ),
    );
    const { bundleDigest: _bundleDigest, ...unsigned } = manifest;
    const earlier = { ...unsigned, bundleSchemaVersion: 1 };
    const versionOne = new Map(files);

    versionOne.set(
      bundlePaths.manifest,
      encodeBundleJson({ ...earlier, bundleDigest: digestManifest(earlier) }),
    );
    const outcomes = (verification: Verification) => {
      return verification.checks.map(({ id, outcome }) => [id, outcome]);
    };

    expect(manifest.bundleSchemaVersion).toBe(2);
    expect(outcomes(verifyBundle(versionOne, 'version 1'))).toEqual(
      outcomes(verifyBundle(files, 'version 2')),
    );
  });

  it('should recompute a bundle at a configured chat depth offline', async () => {
    const run = await createSyntheticRun(path.join(root, 'deep'), {
      chatProbes: { runsPerPrompt: 3 },
    });
    const result = await exportRun(run.dir);
    const source = await readBundleSource(result.archive);

    const verification = verifyBundle(source.files, source.description);

    // 3 questions × 2 surfaces × 3 runs, one slot failed.
    expect(verification.disclosures.capturedAnswers).toBe(17);
    expect(outcomeOf(verification, 'bundle.integrity')?.outcome).toBe('pass');
    expect(outcomeOf(verification, 'plan.accounted')?.outcome).toBe('pass');
    expect(outcomeOf(verification, 'judgments.evidence')?.outcome).toBe('pass');
    expect(outcomeOf(verification, 'metrics.recomputed')?.outcome).toBe('pass');
  });

  it('should refuse a symlink inside a bundle directory', async () => {
    const { run } = await exportSynthetic();
    const [revision] = await readFinalizedRevisions(run.dir);

    await symlink(
      '/etc/hostname',
      path.join(revision?.dir ?? '', 'report', 'link.json'),
    );

    const result = readBundleSource(revision?.dir ?? '');

    await expect(result).rejects.toThrow(/symbolic link/);
  });

  it('should refuse a run directory with no finalized revision', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));

    const result = readBundleSource(run.dir);

    await expect(result).rejects.toThrow(/export it first/);
  });
});

// ============================================================================
// Calculation versions (method release spec §6.3): an export names the
// version its numbers were made with, the verifier recomputes each readable
// version with its own arithmetic, and version 2 puts counts and an interval
// beside every published rate.
// ============================================================================

// The synthetic snapshot carries the sections the verifier compares, not a
// full report.
const sectionsSchema = z.looseObject({
  sections: z.array(
    z.looseObject({ key: z.string(), visibility: aeoVisibilitySchema }),
  ),
});

const snapshotSummaries = (files: ReadonlyMap<string, Buffer>) => {
  return sectionsSchema
    .parse(
      parseBundleJson(
        (files.get(bundlePaths.snapshot) ?? Buffer.alloc(0)).toString('utf8'),
      ),
    )
    .sections.map((section) => section.visibility.summary);
};

const manifestOf = (files: ReadonlyMap<string, Buffer>) => {
  return bundleManifestSchema.parse(
    parseBundleJson(
      (files.get(bundlePaths.manifest) ?? Buffer.alloc(0)).toString('utf8'),
    ),
  );
};

describe('export - calculation versions', () => {
  it('should export and verify version 2, with counts and an interval beside each rate', async () => {
    const { files } = await exportSynthetic();
    const verification = verifyBundle(files, 'synthetic');

    expect(manifestOf(files).calculationVersion).toBe(calculationVersion);
    expect(outcomeOf(verification, 'metrics.recomputed')?.outcome).toBe('pass');

    for (const summary of snapshotSummaries(files)) {
      const evidence = summary.prospectShareOfVoiceEvidence;

      // The rate is the count over the planned answers, inside its interval.
      expect(evidence).toBeDefined();
      expect(summary.prospectShareOfVoice).toBe(
        (evidence?.count ?? NaN) / (evidence?.planned ?? NaN),
      );
      expect(evidence?.low).toBeLessThanOrEqual(
        summary.prospectShareOfVoice ?? NaN,
      );
      expect(evidence?.high).toBeGreaterThanOrEqual(
        summary.prospectShareOfVoice ?? NaN,
      );

      for (const model of Object.values(summary.byModel)) {
        expect(model.shareOfVoiceEvidence).toBeDefined();
        expect(model.citationRateEvidence).toBeDefined();
      }

      for (const competitor of summary.byCompetitor) {
        expect(competitor.capturedAnswers).toBeGreaterThan(0);
      }
    }
  });

  it('should export a directory aggregated with version 1 as version 1, which verifies with its own arithmetic', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'), {
      calculationVersion: 1,
    });
    const files = readArchive(
      await readFile((await exportRun(run.dir)).archive),
    );

    expect(manifestOf(files).calculationVersion).toBe(1);
    expect(
      outcomeOf(verifyBundle(files, 'version 1'), 'metrics.recomputed')
        ?.outcome,
    ).toBe('pass');
    // Version 1 publishes no evidence: its bytes are what it always wrote.
    expect(
      snapshotSummaries(files).every(
        (summary) => summary.prospectShareOfVoiceEvidence === undefined,
      ),
    ).toBe(true);
  });

  // Loose at every level, so re-encoding keeps every key it does not edit.
  const intervalPathSchema = z.looseObject({
    sections: z.array(
      z.looseObject({
        visibility: z.looseObject({
          summary: z.looseObject({
            prospectShareOfVoiceEvidence: z.looseObject({
              high: z.number(),
            }),
          }),
        }),
      }),
    ),
  });

  /** The first section's headline interval, its upper bound replaced, in a
   * re-signed bundle; `replace` keeps the stored value. */
  const withUpperBound = (
    files: ReadonlyMap<string, Buffer>,
    replace: (high: number) => number,
  ) => {
    return forge(
      files,
      new Map([
        [
          bundlePaths.snapshot,
          editJson(files, bundlePaths.snapshot, (value) => {
            const snapshot = intervalPathSchema.parse(value);
            const [first, ...rest] = snapshot.sections;

            if (!first) {
              return value;
            }

            const { summary } = first.visibility;
            const evidence = summary.prospectShareOfVoiceEvidence;

            return {
              ...snapshot,
              sections: [
                {
                  ...first,
                  visibility: {
                    ...first.visibility,
                    summary: {
                      ...summary,
                      prospectShareOfVoiceEvidence: {
                        ...evidence,
                        high: replace(evidence.high),
                      },
                    },
                  },
                },
                ...rest,
              ],
            };
          }),
        ],
      ]),
    );
  };

  it('should fail a forged interval in a re-signed bundle', async () => {
    const { files } = await exportSynthetic();
    const untouched = verifyBundle(
      withUpperBound(files, (high) => high),
      'untouched interval',
    );
    const forged = verifyBundle(
      withUpperBound(files, () => 1),
      'forged interval',
    );

    // The same edit keeping the stored bound passes: only the forged number
    // fails.
    expect(outcomeOf(untouched, 'metrics.recomputed')?.outcome).toBe('pass');
    expect(outcomeOf(forged, 'bundle.integrity')?.outcome).toBe('pass');
    expect(outcomeOf(forged, 'metrics.recomputed')?.code).toBe(
      'snapshot_metrics_mismatch',
    );
  });

  it('should only add evidence in version 2: every number version 1 publishes is unchanged', async () => {
    const versionOne = await createSyntheticRun(path.join(root, 'one'), {
      calculationVersion: 1,
    });
    const versionTwo = await createSyntheticRun(path.join(root, 'two'));
    const aggregateOf = async (dir: string): Promise<unknown> => {
      return JSON.parse(
        await readFile(path.join(dir, 'OUT', 'aggregate.json'), 'utf8'),
      );
    };
    const evidenceKeys = new Set([
      'mentionedAnswers',
      'citedAnswers',
      'capturedAnswers',
    ]);
    const withoutEvidence = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(withoutEvidence);
      }

      if (typeof value !== 'object' || value === null) {
        return value;
      }

      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) => !key.endsWith('Evidence') && !evidenceKeys.has(key),
          )
          .map(([key, nested]) => [key, withoutEvidence(nested)]),
      );
    };

    const one = z
      .looseObject({ version: z.literal(1), sections: z.unknown() })
      .parse(await aggregateOf(versionOne.dir));
    const two = z
      .looseObject({
        version: z.literal(2),
        calculationVersion: z.literal(2),
        sections: z.unknown(),
      })
      .parse(await aggregateOf(versionTwo.dir));

    // Version 1's file names no calculation version, as before.
    expect(Object.keys(one)).not.toContain('calculationVersion');
    expect(one.sections).toEqual(withoutEvidence(two.sections));
  });

  it('should export a damaged aggregate under its recorded version, leaving the damage to the verifier', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));
    const file = path.join(run.dir, 'OUT', 'aggregate.json');
    const stored = z
      .looseObject({ version: z.literal(2) })
      .parse(JSON.parse(await readFile(file, 'utf8')));

    await writeFile(file, JSON.stringify({ ...stored, sections: {} }));

    const files = readArchive(
      await readFile((await exportRun(run.dir)).archive),
    );

    expect(manifestOf(files).calculationVersion).toBe(calculationVersion);
    expect(
      outcomeOf(verifyBundle(files, 'damaged'), 'metrics.recomputed')?.code,
    ).toBe('section_metrics_mismatch');
  });

  it('should refuse to export an aggregate naming a calculation version it cannot read', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));
    const file = path.join(run.dir, 'OUT', 'aggregate.json');
    const stored = z
      .looseObject({ version: z.literal(2) })
      .parse(JSON.parse(await readFile(file, 'utf8')));

    await writeFile(
      file,
      JSON.stringify({ ...stored, calculationVersion: 99 }),
    );

    await expect(exportRun(run.dir)).rejects.toThrow(
      'names no calculation version this release reads',
    );
  });

  it('should report a bundle of an unknown calculation version as unsupported, never recomputing it', async () => {
    const { files } = await exportSynthetic();
    const forged = forge(
      files,
      new Map([
        [
          bundlePaths.manifest,
          editJson(files, bundlePaths.manifest, (value) => ({
            ...bundleManifestSchema.parse(value),
            calculationVersion: 99,
          })),
        ],
      ]),
    );

    const check = outcomeOf(
      verifyBundle(forged, 'unknown version'),
      'metrics.recomputed',
    );

    expect(check?.outcome).toBe('unsupported');
    expect(check?.code).toBe('calculation_version_unsupported');
  });
});

describe('export - probe bindings', () => {
  const methodOf = (files: ReadonlyMap<string, Buffer>) => {
    return z
      .looseObject({ probeBindings: z.unknown() })
      .parse(
        parseBundleJson(
          (files.get(bundlePaths.method) ?? Buffer.alloc(0)).toString('utf8'),
        ),
      );
  };

  it("should name each planned surface's frozen binding in the method, under the method digest", async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));
    const bank = path.join(run.dir, 'BANK');

    await mkdir(bank);
    await resolveRunBindings(bank, { startedBefore: false });
    const files = readArchive(
      await readFile((await exportRun(run.dir)).archive),
    );

    // The synthetic run plans ChatGPT and Perplexity: no other surface's
    // binding enters its method.
    expect(methodOf(files).probeBindings).toEqual({
      chatgpt: defaultProbeBindings.chatgpt,
      perplexity: defaultProbeBindings.perplexity,
    });
    expect(
      outcomeOf(verifyBundle(files, 'bindings'), 'plan.accounted')?.outcome,
    ).toBe('pass');
  });

  it('should record no bindings for a directory that froze none', async () => {
    const { files } = await exportSynthetic();

    expect(methodOf(files).probeBindings).toBeNull();
  });

  it('should refuse a damaged bindings file, naming it, rather than guess', async () => {
    const run = await createSyntheticRun(path.join(root, 'run'));
    const bank = path.join(run.dir, 'BANK');

    await mkdir(bank);
    await writeFile(path.join(bank, 'bindings.json'), '{"version":1}\n');

    await expect(exportRun(run.dir)).rejects.toThrow(
      /BANK\/bindings\.json is not a frozen bindings file/,
    );
  });
});
