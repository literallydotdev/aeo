import { assert, describe, expect, it } from 'vitest';
import {
  aeoAuditConfigSchema,
  aeoSnapshotSchema,
  type AeoAuditConfig,
  type AeoEvidenceChunk,
} from '../schema';
import {
  buildCaptureManifest,
  type CaptureManifest,
} from '../capture-manifest';
import { plannedProbeUnitsForSection } from '../lib/checkpoint';
import {
  deriveProgressComparison,
  selectProgressMeasurements,
} from '../lib/progress-comparison';
import { contentHash } from '../stores/content-hash';
import { progressQuestionSetKey } from '../report/core/progress-question-sets';
import type { CapturedUnitRecord } from '../stores/ports';
import type { AeoSurface } from '../surfaces';
import {
  projectProgressMeasurement,
  type ProgressMeasurementInput,
} from './progress';

const config = (): AeoAuditConfig => {
  return aeoAuditConfigSchema.parse({
    reportKey: 'example',
    slug: 'example',
    brand: { name: 'Example', domain: 'example.com', aliases: ['Example Inc'] },
    competitors: [
      { name: 'Alternative', domain: 'alternative.com', aliases: [] },
    ],
    sections: [
      {
        key: 'content',
        prompts: [
          {
            id: 'p1',
            text: 'Which agency writes technical content?',
            category: 'product_recommendation',
          },
        ],
      },
    ],
    agentProbes: { runsPerPrompt: 2 },
    moneyPages: [],
    productBrief: 'INTERNAL-CONTEXT-DO-NOT-EXPOSE',
    geography: 'us',
    language: 'en',
  });
};

const fixture = (
  options: {
    runId?: string;
    config?: AeoAuditConfig;
    surfaces?: AeoSurface[];
    capturedAt?: string;
    captureDates?: string[];
    missing?: number[];
    mentioned?: number[];
    cited?: number[];
    noOverview?: boolean;
    origins?: Array<string | null>;
    collection?:
      | 'unknown'
      | {
          requestedModel: string | null;
          reportedModel: string | null;
          parameters: Record<string, unknown>;
        };
  } = {},
): Omit<ProgressMeasurementInput, 'captureManifest'> & {
  captureManifest?: CaptureManifest;
} => {
  const cfg = options.config ?? config();
  const runId = options.runId ?? 'baseline';
  const surfaces = options.surfaces ?? ['google_ai_overview'];
  const capturedAt =
    options.capturedAt ??
    (runId === 'baseline'
      ? '2026-09-01T12:00:00.000Z'
      : '2026-09-09T12:00:00.000Z');

  const units = cfg.sections.flatMap((section) =>
    plannedProbeUnitsForSection({
      sectionKey: section.key,
      prompts: section.prompts,
      surfaces,
      agentProbes: cfg.agentProbes,
    }),
  );

  const records: CapturedUnitRecord[] = units.flatMap((unit, index) =>
    options.missing?.includes(index)
      ? []
      : [
          {
            ...unit,
            status: 'captured',
            capturedAt: options.captureDates?.[index] ?? capturedAt,
            runId:
              options.origins?.[index] === null
                ? undefined
                : (options.origins?.[index] ?? runId),
            captureMetadata:
              options.collection === 'unknown'
                ? undefined
                : (options.collection ?? {
                    requestedModel: `observed/${unit.surface}`,
                    reportedModel: null,
                    parameters: {
                      geography: cfg.geography,
                      language: cfg.language,
                    },
                  }),
            probe: {
              promptId: unit.promptId,
              promptText: unit.promptText,
              promptCategory: 'product_recommendation',
              modelName: unit.surface,
              runIndex: unit.runIndex,
              text: options.noOverview
                ? ''
                : 'PRIVATE-RAW-ANSWER: Example provides technical content.',
              ...(options.noOverview ? { noOverview: true as const } : {}),
            },
          },
        ],
  );

  const chunks: AeoEvidenceChunk[] = cfg.sections
    .flatMap((section) =>
      section.prompts.map((prompt, promptIdx) => ({
        sectionKey: section.key,
        promptIdx,
        promptText: prompt.text,
        runs: options.noOverview
          ? []
          : records
              .filter(
                (record) =>
                  record.sectionKey === section.key &&
                  record.promptId === prompt.id,
              )
              .map((record) => ({
                surface: record.surface,
                runIndex: record.runIndex,
                responseText: record.probe.text,
              })),
      })),
    )
    .filter((chunk) => chunk.runs.length);

  const snapshot = aeoSnapshotSchema.parse({
    version: 2,
    reportKey: cfg.reportKey,
    brand: cfg.brand,
    competitors: cfg.competitors,
    sections: cfg.sections.map((section) => ({
      key: section.key,
      visibility: {
        prompts: section.prompts.map(({ text, category }) => ({
          text,
          category,
        })),
        surfaces,
        matrix: units.flatMap((unit, index) =>
          unit.sectionKey !== section.key || options.missing?.includes(index)
            ? []
            : [
                {
                  promptIdx: section.prompts.findIndex(
                    (prompt) => prompt.id === unit.promptId,
                  ),
                  surface: unit.surface,
                  runIndex: unit.runIndex,
                  prospectMentioned:
                    options.mentioned?.includes(index) ?? false,
                  prospectPosition: 'absent',
                  contextSnippet: null,
                  citedUrls: options.cited?.includes(index)
                    ? [
                        'https://docs.example.com/guide',
                        'https://notexample.com/',
                      ]
                    : [],
                  competitors: [],
                  ...(options.noOverview ? { noOverview: true } : {}),
                },
              ],
        ),
        summary: {
          prospectShareOfVoice: 0,
          prospectCitationRate: 0,
          agentShareOfVoice: null,
          agentCitationRate: null,
          byModel: {},
          byCompetitor: [],
          topCompetitorDomain: null,
        },
      },
    })),
    meta: {
      generatedAt: '2026-09-10T00:00:00.000Z',
      promptCount: units.length,
      probeCount: records.length,
      partialFailures: [],
      runId,
      surfaces,
      analyzerVersion: 4,
      models: {
        analyzer: 'openai/gpt-6-astra',
        perception: 'openai/gpt-6-astra',
      },
    },
  });

  return {
    runId,
    config: cfg,
    snapshot,
    publishedAt: '2026-09-10T00:00:00.000Z',
    captureManifest: buildCaptureManifest({
      reportKey: cfg.reportKey,
      runId,
      createdAt: '2026-09-10T00:00:00.000Z',
      config: cfg,
      chunks,
      records,
      surfaces,
    }),
  };
};

const compare = (a: ProgressMeasurementInput, b: ProgressMeasurementInput) => {
  return deriveProgressComparison({
    baseline: projectProgressMeasurement(a),
    current: projectProgressMeasurement(b),
  });
};

const getFirst = <T>(items: readonly T[]): T => {
  const [item] = items;

  assert(item, 'Expected at least one item.');

  return item;
};

const getManifest = (input: { captureManifest?: CaptureManifest }) => {
  const { captureManifest } = input;

  assert(captureManifest, 'Expected the fixture to carry a capture manifest.');

  return captureManifest;
};

describe('progress - projectProgressMeasurement()', () => {
  it('should contain only the safe planned-slot projection and date actual capture time, not later publication', () => {
    const input = fixture({ mentioned: [0], cited: [0] });

    const result = projectProgressMeasurement(input);

    expect(result.state).toBe('independent');
    expect(result.captureWindow).toEqual({
      start: '2026-09-01T12:00:00.000Z',
      end: '2026-09-01T12:00:00.000Z',
    });
    expect(result.slots[0]).toMatchObject({
      captured: true,
      analyzed: true,
      citationObserved: true,
      mentioned: true,
      cited: true,
    });

    const json = JSON.stringify(result);

    expect(json).not.toContain('PRIVATE-RAW-ANSWER');
    expect(json).not.toContain('INTERNAL-CONTEXT');
    expect(json).not.toContain('https://');
    expect(json).not.toContain('Which agency');
    expect(json).not.toContain('Alternative');
  });

  it('should count a captured no-overview absence as an observed zero without requiring answer text', () => {
    const a = fixture({ noOverview: true });

    const point = projectProgressMeasurement(a);

    expect(getManifest(a).captures[0]).toMatchObject({
      noOverview: true,
      hasEvidence: false,
    });
    expect(point.slots[0]).toMatchObject({
      captured: true,
      analyzed: true,
      citationObserved: true,
      mentioned: false,
      cited: false,
    });
    expect(
      compare(a, fixture({ runId: 'current', noOverview: true })).groups.chat,
    ).toMatchObject({
      baseline: { planned: 1, captured: 1, mentionRate: 0, citationRate: 0 },
      current: { mentionRate: 0, citationRate: 0 },
      mentionDeltaPp: 0,
      citationDeltaPp: 0,
    });
  });

  it('should keep failed planned slots in both denominators and report coverage', () => {
    const baseline = fixture({ surfaces: ['claude'], mentioned: [0, 1] });
    const current = fixture({
      runId: 'current',
      surfaces: ['claude'],
      mentioned: [0],
      missing: [1],
    });

    const result = compare(baseline, current);

    expect(result.groups.chat).toMatchObject({
      baseline: { planned: 2, captured: 2, mentioned: 2, mentionRate: 1 },
      current: { planned: 2, captured: 1, mentioned: 1, mentionRate: 0.5 },
      mentionDeltaPp: -50,
    });
    expect(result.status).toBe('partial');
    expect(result.reasons).toContain('incomplete_capture_coverage');
    expect(result.reasons).not.toContain('collection_method_changed');
  });

  it('should keep entirely unavailable outcomes distinct from observed zero', () => {
    const result = compare(
      fixture(),
      fixture({ runId: 'current', missing: [0] }),
    );

    expect(result.groups.chat?.baseline.mentionRate).toBe(0);
    expect(result.groups.chat?.current.mentionRate).toBeNull();
    expect(result.groups.chat?.mentionDeltaPp).toBeNull();
    expect(result.groups.chat?.current.planned).toBe(1);
  });

  it('should NOT infer absent historical citation or capture metadata', () => {
    const old = fixture();
    delete old.captureManifest;
    delete getFirst(getFirst(old.snapshot.sections).visibility.matrix)
      .citedUrls;
    delete old.snapshot.meta.models;

    const projected = projectProgressMeasurement(old);
    const result = compare(old, fixture({ runId: 'current' }));

    expect(projected.state).toBe('legacy');
    expect(projected.captureWindow).toEqual({ start: null, end: null });
    expect(result.groups.chat?.baseline.citationRate).toBeNull();
    expect(result.reasons).toContain('historical_metadata_unknown');
    expect(result.reasons).not.toContain('analyzer_changed');
    expect(result.reasons).not.toContain('collection_method_changed');
  });

  it('should fail closed on a corrupted manifest or mismatched run instead of exposing misleading history', () => {
    const broken = fixture();
    getFirst(getManifest(broken).captures).rawText += ' altered';
    const wrongRun = fixture();
    wrongRun.runId = 'unrelated';

    const brokenPoint = projectProgressMeasurement(broken);
    const wrongRunPoint = projectProgressMeasurement(wrongRun);

    expect(brokenPoint.state).toBe('invalid');
    expect(wrongRunPoint.state).toBe('invalid');
    expect(selectProgressMeasurements([brokenPoint])).toEqual([]);
  });

  it.each([false, 0, '', [], { version: 1 }])(
    'should treat malformed supplied manifest %j as invalid, never missing legacy metadata',
    (captureManifest) => {
      const input = { ...fixture(), captureManifest };

      const projected = projectProgressMeasurement(input);

      expect(projected.state).toBe('invalid');
    },
  );

  it('should bind the preserved plan to its frozen locale and company configuration', () => {
    const changed = fixture();
    changed.config.geography = 'gb';

    const projected = projectProgressMeasurement(changed);

    expect(projected.state).toBe('invalid');
    expect(projected.warnings).toContain('plan_config_mismatch');
  });

  it('should use authoritative manifest repetition counts rather than current planning defaults', () => {
    const source = fixture({ surfaces: ['claude'] });
    const manifest = getManifest(source);
    const section = getFirst(source.snapshot.sections);
    manifest.plan.units = manifest.plan.units.slice(0, 1);
    manifest.captures = manifest.captures.slice(0, 1);
    section.visibility.matrix = section.visibility.matrix.slice(0, 1);
    const { digest: _planDigest, ...plan } = manifest.plan;
    manifest.plan.digest = contentHash(plan);
    const { digest: _manifestDigest, ...rest } = manifest;
    manifest.digest = contentHash(rest);

    const projected = projectProgressMeasurement(source);

    expect(projected.state).toBe('independent');
    expect(projected.slots).toHaveLength(1);
  });

  it.each(['reportedModel', 'parameters'] as const)(
    'should disclose changed %s even under the same requested model alias',
    (field) => {
      const collection = {
        requestedModel: 'provider/stable-alias',
        reportedModel: 'provider/resolved-v1',
        parameters: { temperature: 0.5 },
      };
      const baseline = fixture({ collection });
      const updated = {
        ...collection,
        ...(field === 'reportedModel'
          ? { reportedModel: 'provider/resolved-v2' }
          : { parameters: { temperature: 0.9 } }),
      };

      const result = compare(
        baseline,
        fixture({ runId: 'current', collection: updated }),
      );

      expect(result.status).toBe('partial');
      expect(result.reasons).toContain('collection_method_changed');
    },
  );

  it('should mark missing collection identity unknown even when capture origin and date are fresh', () => {
    const current = fixture({ runId: 'current', collection: 'unknown' });

    const projected = projectProgressMeasurement(current);

    expect(projected.state).toBe('independent');
    expect(getFirst(projected.slots).collectionMetadataKnown).toBe(false);
    expect(compare(fixture(), current).reasons).toContain(
      'collection_metadata_unknown',
    );
  });

  it('should remove analysis replay and duplicate physical measurements from new points', () => {
    const original = projectProgressMeasurement(fixture());
    const replay = fixture({ runId: 'analysis' });
    replay.snapshot.meta.derivedFromRunId = 'baseline';
    replay.snapshot.meta.replayKind = 'analysis';
    const resumed = fixture({
      runId: 'resumed',
      origins: ['baseline'],
      capturedAt: '2026-09-01T12:00:00.000Z',
    });
    const copyOnly = { ...original, publishedAt: '2026-10-01T00:00:00.000Z' };

    const selected = selectProgressMeasurements([
      original,
      projectProgressMeasurement(replay),
      projectProgressMeasurement(resumed),
      copyOnly,
    ]);

    expect(projectProgressMeasurement(resumed).state).toBe('reused');
    expect(selected).toEqual([original]);
    expect(compare(fixture(), resumed).reasons).toContain('same_measurement');
  });

  it('should keep the first publication of a proven collection completed by an analysis retry', () => {
    const original = projectProgressMeasurement(
      fixture({ runId: 'failed-collector' }),
    );
    const retry = projectProgressMeasurement(
      fixture({ runId: 'retry', origins: ['failed-collector'] }),
    );
    const before = structuredClone(retry);

    const selectedRetry = selectProgressMeasurements([retry]);

    expect(retry.state).toBe('reused');
    expect(retry.reusedCaptures).toBe(1);
    expect(retry.measurementId).toBe(original.measurementId);
    expect(retry.captureWindow).toEqual(original.captureWindow);
    expect(getFirst(retry.slots).captureId).toBe(
      getFirst(original.slots).captureId,
    );
    expect(selectedRetry).toEqual([retry]);
    expect(retry).toEqual(before);

    const baseline = projectProgressMeasurement(fixture());

    const selected = selectProgressMeasurements([retry, baseline]);
    const comparison = deriveProgressComparison({ baseline, current: retry });

    expect(selected).toEqual([baseline, retry]);
    expect(comparison.status).toBe('partial');
    expect(comparison.reasons).toEqual(['includes_reused_captures']);
    expect(comparison.groups.chat?.current.captured).toBe(1);
  });

  it('should retain the earliest known publication of a physical collection regardless of retry run ID or input order', () => {
    const first = projectProgressMeasurement(
      fixture({ runId: 'z-first-published' }),
    );
    first.publishedAt = '2026-09-10T01:00:00.000Z';
    const retry = projectProgressMeasurement(
      fixture({ runId: 'a-retry', origins: ['z-first-published'] }),
    );
    retry.publishedAt = '2026-09-11T01:00:00.000Z';
    const copyOnly = { ...first, publishedAt: '2026-09-12T01:00:00.000Z' };

    const comparison = deriveProgressComparison({
      baseline: first,
      current: retry,
    });

    expect(first.measurementId).toBe(retry.measurementId);
    expect(selectProgressMeasurements([retry, copyOnly, first])).toEqual([
      first,
    ]);
    expect(selectProgressMeasurements([first, retry, copyOnly])).toEqual([
      first,
    ]);
    expect(comparison.status).toBe('unavailable');
    expect(comparison.reasons).toContain('same_measurement');
    expect(comparison.groups).toEqual({ chat: null, agents: null });
  });

  it.each(['measurement', 'window', 'capture', 'empty'] as const)(
    'should exclude reused legacy results without their %s identity evidence',
    (missing) => {
      const retry = projectProgressMeasurement(
        fixture({ runId: 'retry', origins: ['failed-collector'] }),
      );

      if (missing === 'measurement') {
        retry.measurementId = null;
      } else if (missing === 'window') {
        retry.captureWindow = { start: null, end: null };
      } else if (missing === 'capture') {
        getFirst(retry.slots).captureId = null;
      } else {
        retry.slots = [];
      }

      const selected = selectProgressMeasurements([retry]);
      const comparison = deriveProgressComparison({
        baseline: projectProgressMeasurement(fixture()),
        current: retry,
      });

      expect(selected).toEqual([]);
      expect(comparison.reasons).toContain('measurement_not_independent');
    },
  );

  it('should keep different recovered collections as distinct dated points while preserving method cautions', () => {
    const earlier = projectProgressMeasurement(
      fixture({
        runId: 'retry-one',
        origins: ['collector-one'],
        capturedAt: '2026-09-01T12:00:00.000Z',
      }),
    );
    const later = projectProgressMeasurement(
      fixture({
        runId: 'retry-two',
        origins: ['collector-two'],
        collection: 'unknown',
      }),
    );

    const selected = selectProgressMeasurements([later, earlier]);
    const comparison = deriveProgressComparison({
      baseline: earlier,
      current: later,
    });

    expect(earlier.measurementId).not.toBe(later.measurementId);
    expect(selected).toEqual([earlier, later]);
    expect(comparison.status).toBe('partial');
    expect(comparison.reasons).toEqual(
      expect.arrayContaining([
        'collection_metadata_unknown',
        'includes_reused_captures',
      ]),
    );
  });

  it('should detect duplicated capture sets even if their run IDs were rewritten', () => {
    const original = projectProgressMeasurement(fixture());
    const capturedAt = original.captureWindow.end;

    assert(capturedAt);

    const renamed = projectProgressMeasurement(
      fixture({ runId: 'renamed', capturedAt }),
    );

    const selected = selectProgressMeasurements([original, renamed]);
    const comparison = deriveProgressComparison({
      baseline: original,
      current: renamed,
    });

    expect(renamed.measurementId).toBe(original.measurementId);
    expect(selected).toHaveLength(1);
    expect(comparison.reasons).toContain('same_measurement');
  });

  it('should retain mixed new/reused measurements with an explicit caveat', () => {
    const mixed = projectProgressMeasurement(
      fixture({
        runId: 'mixed',
        surfaces: ['claude'],
        origins: ['baseline', 'mixed'],
      }),
    );
    const baseline = projectProgressMeasurement(
      fixture({ surfaces: ['claude'] }),
    );

    const comparison = deriveProgressComparison({ baseline, current: mixed });

    expect(mixed.state).toBe('mixed');
    expect(mixed.reusedCaptures).toBe(1);
    expect(comparison.reasons).toContain('includes_reused_captures');
  });

  it('should NOT claim progress when only a newly added question has fresh captures', () => {
    const cfg = config();
    const section = getFirst(cfg.sections);
    section.prompts.push({
      ...getFirst(section.prompts),
      id: 'new-question',
      text: 'Which agency writes API tutorials?',
    });
    const baseline = projectProgressMeasurement(fixture());
    const current = projectProgressMeasurement(
      fixture({
        runId: 'mixed',
        config: cfg,
        origins: ['baseline', 'mixed'],
        captureDates: ['2026-09-01T12:00:00.000Z', '2026-09-09T12:00:00.000Z'],
        mentioned: [0, 1],
      }),
    );
    current.analyzer.version = 5;

    const result = deriveProgressComparison({ baseline, current });

    expect(current.state).toBe('mixed');
    expect(current.measurementId).not.toBe(baseline.measurementId);
    // The only shared question reuses the baseline's answer.
    expect(result.status).toBe('unavailable');
    expect(result.reasons).toEqual([
      'questions_changed',
      'matched_captures_reused',
    ]);
    expect(result.groups.chat).toBeNull();
  });

  it('should NOT claim agent progress when the mixed run only refreshes chat answers', () => {
    const baseline = projectProgressMeasurement(
      fixture({ surfaces: ['google_ai_overview', 'codex'] }),
    );
    const current = projectProgressMeasurement(
      fixture({
        runId: 'mixed',
        surfaces: ['google_ai_overview', 'codex'],
        origins: ['mixed', 'baseline', 'baseline'],
        captureDates: [
          '2026-09-09T12:00:00.000Z',
          '2026-09-01T12:00:00.000Z',
          '2026-09-01T12:00:00.000Z',
        ],
      }),
    );

    const agents = deriveProgressComparison(
      { baseline, current },
      { scope: 'agents' },
    );
    const chat = deriveProgressComparison(
      { baseline, current },
      { scope: 'chat' },
    );

    expect(agents.status).toBe('unavailable');
    expect(agents.reasons).toContain('matched_captures_reused');
    expect(chat.groups.chat?.mentionDeltaPp).toBe(0);
  });
});

describe('progress - deriveProgressComparison()', () => {
  it('should match reordered exact questions despite changed IDs', () => {
    const cfg = config();
    const section = getFirst(cfg.sections);
    section.prompts.push({
      ...getFirst(section.prompts),
      id: 'p2',
      text: 'Who writes documentation?',
    });
    const reordered = structuredClone(cfg);
    const reorderedSection = getFirst(reordered.sections);
    reorderedSection.prompts = [...reorderedSection.prompts]
      .reverse()
      .map((prompt, index) => ({ ...prompt, id: `new${index}` }));

    const result = compare(
      fixture({ config: cfg, mentioned: [0] }),
      fixture({ runId: 'current', config: reordered, mentioned: [1] }),
    );

    expect(result.status).toBe('comparable');
    expect(result.matched).toMatchObject({
      questions: 2,
      slots: 2,
      baselineExcludedSlots: 0,
      currentExcludedSlots: 0,
    });
    expect(result.groups.chat?.mentionDeltaPp).toBe(0);
  });

  it('should never match changed question text merely because its ID is unchanged', () => {
    const changed = config();
    getFirst(getFirst(changed.sections).prompts).text =
      'Which agency builds production software?';

    const result = compare(
      fixture(),
      fixture({ runId: 'current', config: changed, mentioned: [0] }),
    );

    // Its only question changed, so no question is shared.
    expect(result.status).toBe('unavailable');
    expect(result.reasons).toEqual(['no_shared_questions']);
    expect(result.groups.chat).toBeNull();
  });

  it('should reject added surfaces until a filter selects an unchanged measurement scope', () => {
    const baseline = projectProgressMeasurement(
      fixture({ surfaces: ['google_ai_overview', 'codex'], mentioned: [1, 2] }),
    );
    const current = projectProgressMeasurement(
      fixture({
        runId: 'current',
        surfaces: ['google_ai_overview', 'claude', 'codex'],
        mentioned: [1, 2, 3, 4],
      }),
    );

    const result = deriveProgressComparison({ baseline, current });
    const chat = deriveProgressComparison(
      { baseline, current },
      { surface: 'google_ai_overview' },
    );
    const agents = deriveProgressComparison(
      { baseline, current },
      { scope: 'agents', surface: 'codex' },
    );

    expect(result.status).toBe('unavailable');
    expect(result.reasons).toEqual(['scope_changed']);
    expect(result.matched).toMatchObject({ slots: 3, currentExcludedSlots: 2 });
    expect(result.groups).toEqual({ chat: null, agents: null });
    expect(chat.status).toBe('comparable');
    expect(chat.groups.chat).toMatchObject({
      baseline: { planned: 1, mentionRate: 0 },
      current: { planned: 1, mentionRate: 0 },
      mentionDeltaPp: 0,
    });
    expect(agents.status).toBe('comparable');
    expect(agents.groups.agents).toMatchObject({
      baseline: { planned: 2, mentionRate: 1 },
      current: { planned: 2, mentionRate: 1 },
      mentionDeltaPp: 0,
    });
    expect(agents.groups.chat).toBeNull();
  });

  it('should reject changed repetition counts instead of comparing only their overlap', () => {
    const cfg = config();
    cfg.agentProbes.runsPerPrompt = 1;

    const result = compare(
      fixture({ surfaces: ['codex'], mentioned: [0] }),
      fixture({
        runId: 'current',
        config: cfg,
        surfaces: ['codex'],
        mentioned: [0],
      }),
    );

    expect(result.status).toBe('unavailable');
    expect(result.reasons).toEqual(['scope_changed']);
    expect(result.groups.agents).toBeNull();
    expect(result.matched.baselineExcludedSlots).toBe(1);
  });

  it('should keep a reordered whole set but refuse a changed first-N agent subset', () => {
    const cfg = config();
    const section = getFirst(cfg.sections);
    const prompt = getFirst(section.prompts);
    section.prompts.push(
      { ...prompt, id: 'p2', text: 'Who writes documentation?' },
      { ...prompt, id: 'p3', text: 'Who writes API tutorials?' },
    );
    cfg.agentProbes.maxPromptsPerSection = 2;
    const reordered = structuredClone(cfg);
    getFirst(reordered.sections).prompts.reverse();
    const baseline = projectProgressMeasurement(
      fixture({ config: cfg, surfaces: ['google_ai_overview', 'codex'] }),
    );
    const current = projectProgressMeasurement(
      fixture({
        runId: 'current',
        config: reordered,
        surfaces: ['google_ai_overview', 'codex'],
      }),
    );

    const agents = deriveProgressComparison(
      { baseline, current },
      { scope: 'agents' },
    );
    const chat = deriveProgressComparison(
      { baseline, current },
      { scope: 'chat' },
    );

    expect(progressQuestionSetKey(baseline)).toBe(
      progressQuestionSetKey(current),
    );
    expect(agents).toMatchObject({
      status: 'unavailable',
      reasons: ['scope_changed'],
    });
    expect(chat.status).toBe('comparable');
  });

  it('should retain a question-set display name without changing capture or measurement identity', () => {
    const named = { ...config(), questionSetName: 'Engineering buyers' };
    const renamed = { ...named, questionSetName: 'Developer buying questions' };
    const source = fixture({ config: named });
    const changed = fixture({ config: renamed });

    const first = projectProgressMeasurement(source);
    const second = projectProgressMeasurement(changed);

    expect(first.questionSetName).toBe('Engineering buyers');
    expect(second.questionSetName).toBe('Developer buying questions');
    expect(source.captureManifest?.plan).toEqual(changed.captureManifest?.plan);
    expect(first.measurementId).toBe(second.measurementId);
    expect(progressQuestionSetKey(first)).toBe(progressQuestionSetKey(second));
    expect(JSON.stringify(first)).not.toContain(
      'INTERNAL-CONTEXT-DO-NOT-EXPOSE',
    );
    expect(first).not.toHaveProperty('config');
  });

  it('should filter the same exact question in different sections independently', () => {
    const cfg = config();
    cfg.sections.push({
      ...structuredClone(getFirst(cfg.sections)),
      key: 'agencies',
    });
    const baseline = projectProgressMeasurement(
      fixture({ config: cfg, mentioned: [0] }),
    );
    const current = projectProgressMeasurement(
      fixture({ runId: 'current', config: cfg, mentioned: [1] }),
    );

    const content = deriveProgressComparison(
      { baseline, current },
      { sectionKey: 'content' },
    );
    const agencies = deriveProgressComparison(
      { baseline, current },
      { sectionKey: 'agencies' },
    );

    expect(content.groups.chat?.mentionDeltaPp).toBe(-100);
    expect(agencies.groups.chat?.mentionDeltaPp).toBe(100);
  });

  it.each(['brand', 'geography', 'language'] as const)(
    'should NOT compare changed %s scope',
    (field) => {
      const changed = config();

      if (field === 'brand') {
        changed.brand.domain = 'unrelated.example';
      } else {
        changed[field] = field === 'geography' ? 'gb' : 'no';
      }

      const result = compare(
        fixture(),
        fixture({ runId: 'current', config: changed }),
      );

      expect(result.status).toBe('unavailable');
    },
  );

  it('should disclose analyzer and capture method changes instead of claiming identical conditions', () => {
    const baseline = projectProgressMeasurement(fixture());
    const current = projectProgressMeasurement(fixture({ runId: 'current' }));
    current.analyzer.version = 5;
    getFirst(current.slots).collectionMethodDigest = 'changed-method';

    const result = deriveProgressComparison({ baseline, current });

    expect(result.status).toBe('partial');
    expect(result.reasons).toEqual([
      'analyzer_changed',
      'collection_method_changed',
    ]);
  });

  it('should refuse duplicate question plans instead of double-counting ambiguous observations', () => {
    const duplicate = config();
    const section = getFirst(duplicate.sections);
    section.prompts.push({ ...getFirst(section.prompts), id: 'duplicate' });

    const projected = projectProgressMeasurement(
      fixture({ config: duplicate }),
    );

    expect(projected.state).toBe('invalid');
    expect(projected.warnings).toContain('duplicate_planned_slots');
  });

  it('should retain exact model and source metadata privately without reusing its original digest as public data', () => {
    const source = fixture();

    const point = projectProgressMeasurement(source);

    expect(point.measurementId).toMatch(/^[a-f0-9]{64}$/);
    expect(point.measurementId).not.toBe(contentHash(source.captureManifest));
    expect(getFirst(point.slots).requestedModel).toBe(
      'observed/google_ai_overview',
    );
  });
});
