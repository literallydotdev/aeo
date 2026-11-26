import { describe, expect, it } from 'vitest';
import {
  aeoAuditConfigSchema,
  aeoSnapshotSchema,
  type AeoAuditConfig,
  type AeoEvidenceChunk,
} from '../schema';
import { buildCaptureManifest } from '../capture-manifest';
import { plannedProbeUnitsForSection } from '../lib/checkpoint';
import {
  createGroundingBundle,
  validateGroundingBundle,
} from '../grounding/validation';
import {
  groundingPolicyVersion,
  groundingSchemaVersion,
} from '../grounding/schema';
import { projectProgressMeasurement } from '../analysis/progress';
import { validateReportArtifacts } from '../stores/artifacts';
import { contentHash } from '../stores/content-hash';
import type { CapturedUnitRecord } from '../stores/ports';
import type { AeoSurface } from '../surfaces';
import { bundlePaths } from './contracts';
import { encodeBundleJson } from './json';
import {
  RebindError,
  rebindConfig,
  rebindImportedRun,
  type RebindTarget,
} from './rebind';

// A local run as an exported bundle carries it: the frozen config, the
// snapshot, the labels, the capture manifest, the grounding and the
// aggregate's evidence chunks, all sealed to the local report key and run.
// One capture was reused from an earlier local run.

const localRunId = '01LOCALRUN0000000000000000';
const earlierRunId = '01EARLIERRUN00000000000000';
const surfaces: AeoSurface[] = ['chatgpt', 'perplexity'];
const answer = 'Acmebase is the simplest hosted database for a small team.';

const target: RebindTarget = {
  reportKey: 'acmebase-2026-q4',
  slug: 'acmebase-2026-q4-Ab3dE',
  configVersion: 3,
  runId: '01HOSTEDRUN000000000000000',
};

const localConfig: AeoAuditConfig = aeoAuditConfigSchema.parse({
  reportKey: 'local-acmebase',
  slug: 'local-acmebase',
  brand: { name: 'Acmebase', domain: 'acmebase.test', aliases: [] },
  competitors: [{ name: 'Rivalstack', domain: 'rivalstack.test', aliases: [] }],
  sections: [
    {
      key: 'hosting',
      prompts: [
        {
          id: 'h1',
          text: 'Which hosted databases suit a small team?',
          category: 'product_recommendation',
        },
      ],
    },
  ],
  moneyPages: [],
  productBrief: 'A hosted database for small teams.',
  geography: 'us',
  language: 'en',
});

const localBundle = (): Map<string, Buffer> => {
  const units = localConfig.sections.flatMap((section) =>
    plannedProbeUnitsForSection({
      sectionKey: section.key,
      prompts: section.prompts,
      surfaces,
      agentProbes: localConfig.agentProbes,
      chatProbes: localConfig.chatProbes,
    }),
  );
  const records: CapturedUnitRecord[] = units.map((unit, index) => ({
    ...unit,
    status: 'captured',
    runId: index === 0 ? earlierRunId : localRunId,
    capturedAt: '2026-11-24T10:00:00.000Z',
    captureMetadata: {
      requestedModel: `observed/${unit.surface}`,
      reportedModel: null,
      parameters: {},
    },
    probe: {
      promptId: unit.promptId,
      promptText: unit.promptText,
      promptCategory: 'product_recommendation',
      modelName: unit.surface,
      runIndex: unit.runIndex,
      text: answer,
    },
  }));
  const chunks: AeoEvidenceChunk[] = [
    {
      sectionKey: 'hosting',
      promptIdx: 0,
      promptText: 'Which hosted databases suit a small team?',
      runs: records.map((record) => ({
        surface: record.surface,
        runIndex: record.runIndex,
        responseText: record.probe.text,
      })),
    },
  ];
  const captureManifest = buildCaptureManifest({
    reportKey: localConfig.reportKey,
    runId: localRunId,
    createdAt: '2026-11-24T10:30:00.000Z',
    config: localConfig,
    chunks,
    records,
    surfaces,
  });
  const [first] = captureManifest.captures;

  if (!first) {
    throw new Error('The fixture captured nothing.');
  }

  const grounding = createGroundingBundle({
    schemaVersion: groundingSchemaVersion,
    policyVersion: groundingPolicyVersion,
    configIdentity: { reportKey: localConfig.reportKey, configVersion: 1 },
    runId: localRunId,
    reviewAsOf: '2026-11-24T10:20:00.000Z',
    sources: [],
    facts: [],
    candidates: [
      {
        id: 'claim-1',
        proposition: 'Acmebase is a hosted database.',
        scope: {
          product: 'Acmebase',
          generation: null,
          version: null,
          applicableAt: null,
        },
        category: 'identity',
        occurrences: [
          {
            answerId: first.id,
            runId: localRunId,
            section: first.sectionKey,
            promptId: first.promptId,
            surface: first.surface,
            runIndex: first.runIndex,
            capturedAt: first.capturedAt,
            answerDigest: first.answerDigest,
            start: 0,
            end: 'Acmebase'.length,
            quote: 'Acmebase',
          },
        ],
        disposition: 'selected',
        duplicateOf: null,
        priority: 0,
      },
    ],
    assessments: [],
    coverage: {
      suppliedAnswers: captureManifest.captures.length,
      extractedAnswers: captureManifest.captures.length,
      truncatedAnswers: 0,
      selectedCandidates: 1,
      overflowCandidates: 0,
      stopReason: 'research_disabled',
      retrievals: [],
      gaps: [],
    },
    adjudication: null,
  });
  const snapshot = aeoSnapshotSchema.parse({
    version: 2,
    reportKey: localConfig.reportKey,
    brand: localConfig.brand,
    competitors: localConfig.competitors,
    sections: [
      {
        key: 'hosting',
        visibility: {
          prompts: [
            {
              text: 'Which hosted databases suit a small team?',
              category: 'product_recommendation',
            },
          ],
          surfaces,
          matrix: units.map((unit) => ({
            promptIdx: 0,
            surface: unit.surface,
            runIndex: unit.runIndex,
            prospectMentioned: true,
            prospectPosition: 'primary',
            contextSnippet: null,
            citedUrls: [],
            competitors: [],
          })),
          summary: {
            prospectShareOfVoice: 1,
            prospectCitationRate: 0,
            agentShareOfVoice: null,
            agentCitationRate: null,
            byModel: {},
            byCompetitor: [],
            topCompetitorDomain: null,
          },
        },
      },
    ],
    meta: {
      generatedAt: '2026-11-24T10:30:00.000Z',
      promptCount: 1,
      probeCount: units.length,
      partialFailures: [],
      runId: localRunId,
      surfaces,
      analyzerVersion: 4,
    },
  });
  const labels = { version: 4, model: 'synthetic-labels', entries: {} };
  const aggregate = {
    calculationVersion: 2,
    sections: { hosting: { evidenceChunks: chunks } },
  };

  return new Map(
    Object.entries({
      [bundlePaths.config]: localConfig,
      [bundlePaths.snapshot]: snapshot,
      [bundlePaths.labels]: labels,
      [bundlePaths.captureManifest]: captureManifest,
      [bundlePaths.grounding]: grounding,
      [bundlePaths.aggregate]: aggregate,
      [bundlePaths.partialFailures]: [],
    }).map(([file, value]) => [file, encodeBundleJson(value)]),
  );
};

const documentOf = (files: Map<string, Buffer>, file: string): unknown => {
  const bytes = files.get(file);

  if (!bytes) {
    throw new Error(`The fixture has no ${file}.`);
  }

  return JSON.parse(bytes.toString('utf8'));
};

/** Every JSON path at which two documents differ, digests excluded. */
const changedPaths = (left: unknown, right: unknown, at = ''): string[] => {
  if (
    typeof left === 'object' &&
    left !== null &&
    typeof right === 'object' &&
    right !== null
  ) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

    return [...keys].flatMap((key) =>
      changedPaths(
        Reflect.get(left, key),
        Reflect.get(right, key),
        at ? `${at}.${key}` : key,
      ),
    );
  }

  if (left === right || /(^|\.)(digest|sourceBundleDigest)$/.test(at)) {
    return [];
  }

  return [at.replace(/\.\d+(?=\.|$)/g, '.*')];
};

const unique = (paths: string[]): string[] => {
  return [...new Set(paths)].sort();
};

describe('rebind - rebindImportedRun()', () => {
  it('should pass every hosted artifact check for the hosted identity', () => {
    const rebound = rebindImportedRun(localBundle(), target);

    expect(() =>
      validateReportArtifacts(
        {
          snapshot: rebound.snapshot,
          labels: rebound.labels,
          chunks: rebound.chunks,
          fullScope: true,
          configVersion: target.configVersion,
          captureManifest: rebound.captureManifest,
          grounding: rebound.grounding,
        },
        target.reportKey,
        target.runId,
      ),
    ).not.toThrow();
    expect(() =>
      validateGroundingBundle(rebound.grounding, {
        reportKey: target.reportKey,
        configVersion: target.configVersion,
        runId: target.runId,
      }),
    ).not.toThrow();
    expect(rebound.config).toMatchObject({
      reportKey: target.reportKey,
      slug: target.slug,
      brand: localConfig.brand,
    });
  });

  it('should change the bundle only at the identity paths', () => {
    const files = localBundle();
    const rebound = rebindImportedRun(files, target);

    expect(
      unique(
        changedPaths(documentOf(files, bundlePaths.config), rebound.config),
      ),
    ).toEqual(['reportKey', 'slug']);
    expect(
      unique(
        changedPaths(documentOf(files, bundlePaths.snapshot), rebound.snapshot),
      ),
    ).toEqual(['meta.runId', 'reportKey']);
    expect(
      unique(
        changedPaths(
          documentOf(files, bundlePaths.captureManifest),
          rebound.captureManifest,
        ),
      ),
    ).toEqual(['captures.*.originRunId', 'reportKey', 'runId']);
    expect(
      unique(
        changedPaths(
          documentOf(files, bundlePaths.grounding),
          rebound.grounding,
        ),
      ),
    ).toEqual([
      'candidates.*.occurrences.*.runId',
      'configIdentity.configVersion',
      'configIdentity.reportKey',
      'runId',
    ]);
    expect(rebound.chunks).toEqual(
      (
        documentOf(files, bundlePaths.aggregate) as {
          sections: { hosting: { evidenceChunks: unknown } };
        }
      ).sections.hosting.evidenceChunks,
    );
  });

  it('should keep a reused capture naming the run it came from', () => {
    const rebound = rebindImportedRun(localBundle(), target);
    const origins = rebound.captureManifest.captures.map(
      (capture) => capture.originRunId,
    );

    expect(origins[0]).toBe(earlierRunId);
    expect(origins.slice(1).every((origin) => origin === target.runId)).toBe(
      true,
    );

    const measurement = projectProgressMeasurement({
      runId: target.runId,
      config: rebound.config,
      snapshot: rebound.snapshot,
      captureManifest: rebound.captureManifest,
    });

    expect(measurement.state).toBe('mixed');
    expect(measurement.reusedCaptures).toBe(1);
  });

  it('should identify the same captures as the same measurement', () => {
    const local = projectProgressMeasurement({
      runId: localRunId,
      config: localConfig,
      snapshot: aeoSnapshotSchema.parse(
        documentOf(localBundle(), bundlePaths.snapshot),
      ),
      captureManifest: documentOf(localBundle(), bundlePaths.captureManifest),
    });
    const rebound = rebindImportedRun(localBundle(), target);
    const hosted = projectProgressMeasurement({
      runId: target.runId,
      config: rebound.config,
      snapshot: rebound.snapshot,
      captureManifest: rebound.captureManifest,
    });

    expect(hosted.measurementId).toBe(local.measurementId);
  });

  it('should be deterministic', () => {
    expect(rebindImportedRun(localBundle(), target).digest).toBe(
      rebindImportedRun(localBundle(), target).digest,
    );
    expect(
      rebindImportedRun(localBundle(), { ...target, runId: 'other' }).digest,
    ).not.toBe(rebindImportedRun(localBundle(), target).digest);
  });

  it('should rebind the config the same way the run rebinds it', () => {
    const files = localBundle();

    expect(rebindConfig(files, target)).toEqual(
      rebindImportedRun(files, target).config,
    );
  });

  it('should rebind a bundle without grounding', () => {
    const files = localBundle();

    files.delete(bundlePaths.grounding);

    expect(rebindImportedRun(files, target).grounding).toBeNull();
  });

  it('should refuse a bundle whose answers no longer match their digests', () => {
    const files = localBundle();
    const manifest = documentOf(files, bundlePaths.captureManifest) as {
      captures: Array<{ text: string }>;
    };
    const [capture] = manifest.captures;

    if (!capture) {
      throw new Error('The fixture captured nothing.');
    }

    capture.text = `${capture.text} (edited)`;
    files.set(bundlePaths.captureManifest, encodeBundleJson(manifest));

    expect(() => rebindImportedRun(files, target)).toThrow(RebindError);
  });

  it('should refuse a bundle without a snapshot', () => {
    const files = localBundle();

    files.delete(bundlePaths.snapshot);

    expect(() => rebindImportedRun(files, target)).toThrow(
      /has no report\/snapshot\.json/,
    );
  });

  it('should not leave a stale local identity anywhere in the rebound run', () => {
    const rebound = rebindImportedRun(localBundle(), target);
    const text = JSON.stringify({ ...rebound, digest: undefined });
    const reusedMentions = text.split(earlierRunId).length - 1;

    expect(text).not.toContain(localRunId);
    expect(text).not.toContain('local-acmebase');
    expect(reusedMentions).toBe(1);
    expect(contentHash(rebound.chunks)).toBe(
      contentHash(
        (
          documentOf(localBundle(), bundlePaths.aggregate) as {
            sections: { hosting: { evidenceChunks: unknown } };
          }
        ).sections.hosting.evidenceChunks,
      ),
    );
  });
});
