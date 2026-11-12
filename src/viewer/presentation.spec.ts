import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CalculationVersion } from '../bundle/contracts';
import { exportRun } from '../bundle/export';
import { readBundleSource } from '../bundle/read';
import { createSyntheticRun } from '../bundle/__fixtures__/synthetic-run';
import { presentReport, type ReportPresentation } from './presentation';

const snapshotPath = 'report/snapshot.json';

const editableSnapshotSchema = z.looseObject({
  meta: z.looseObject({}),
  sections: z.array(
    z.looseObject({
      visibility: z.looseObject({ summary: z.looseObject({}) }),
    }),
  ),
});

let root: string;
let runs = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-viewer-presentation-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exportedFiles = async (
  options: Parameters<typeof createSyntheticRun>[1] = {},
) => {
  runs += 1;
  const run = await createSyntheticRun(path.join(root, `run-${runs}`), options);
  const { archive } = await exportRun(run.dir);
  const { files } = await readBundleSource(archive);

  return files;
};

/** The bundle's files with its snapshot's meta, and its first section's
 * summary, patched. */
const withSnapshot = (
  files: ReadonlyMap<string, Buffer>,
  {
    meta = {},
    summary = {},
  }: { meta?: Record<string, unknown>; summary?: Record<string, unknown> },
) => {
  const snapshot = editableSnapshotSchema.parse(
    JSON.parse(String(files.get(snapshotPath))),
  );
  const [first, ...rest] = snapshot.sections;
  const edited = {
    ...snapshot,
    meta: { ...snapshot.meta, ...meta },
    sections:
      first === undefined
        ? []
        : [
            {
              ...first,
              visibility: {
                ...first.visibility,
                summary: { ...first.visibility.summary, ...summary },
              },
            },
            ...rest,
          ],
  };

  return new Map(files).set(snapshotPath, Buffer.from(JSON.stringify(edited)));
};

const shown = (presentation: ReportPresentation) => {
  if (presentation.outcome !== 'shown') {
    throw new Error(`The report is not shown: ${presentation.outcome}.`);
  }

  return presentation;
};

const presentVersion = async (calculationVersion: CalculationVersion) => {
  return shown(presentReport(await exportedFiles({ calculationVersion })));
};

describe('viewer - presentReport()', () => {
  it('should show each measured rate with its interval and the counts behind it', async () => {
    const [section] = (await presentVersion(2)).sections;

    expect(section?.scorecards).toEqual([
      {
        headline: '25%',
        // Two of the eight planned answers are missing: the interval covers
        // both outcomes for them.
        headlineInterval: {
          text: 'approx. 95% interval 7–79%',
          label:
            'approx. 95% interval 7–79% for share of voice across AI assistants',
          counts: 'Mentioned in 2 of 8 planned answers; 6 captured',
        },
        label: 'Share of voice — AI assistants',
        detail: '25% citation rate across ChatGPT and Perplexity',
        detailInterval: {
          text: 'approx. 95% interval 7–79%',
          label:
            'approx. 95% interval 7–79% for citation rate across AI assistants',
          counts: 'Cited in 2 of 8 planned answers; 6 captured',
        },
      },
      // No coding agent was planned: no tile, never a measured 0%.
      {
        headline: '100%',
        label: 'Rivalstack share of voice',
        detail: 'Named most often: 6 of 6 captured answers',
      },
      {
        headline: '1/3',
        label: 'Cells with zero mentions',
        detail: 'Prompts and surfaces where the brand was absent',
      },
    ]);
    expect(section?.surfaceRates.map((row) => row.shareOfVoice)).toEqual([
      {
        percent: '25%',
        interval: {
          text: 'approx. 95% interval 4–96%',
          label: 'approx. 95% interval 4–96% for ChatGPT share of voice',
          counts: 'Mentioned in 1 of 4 planned answers; 2 captured',
        },
      },
      {
        percent: '25%',
        interval: {
          text: 'approx. 95% interval 4–70%',
          label: 'approx. 95% interval 4–70% for Perplexity share of voice',
          counts: 'Mentioned in 1 of 4 planned answers; 4 captured',
        },
      },
    ]);
  });

  it('should show a version 1 bundle bare rates, and no table by surface', async () => {
    const [section] = (await presentVersion(1)).sections;

    expect(section?.scorecards[0]).toEqual({
      headline: '25%',
      label: 'Share of voice — AI assistants',
      detail: '25% citation rate across ChatGPT and Perplexity',
    });
    expect(section?.surfaceRates).toEqual([]);
  });

  it('should show the consumer-app pair only for a run that planned a consumer app', async () => {
    const apps = shown(
      presentReport(
        await exportedFiles({
          consumerApps: ['chatgpt_app', 'google_ai_mode'],
        }),
      ),
    );
    const [card] = (apps.sections[0]?.scorecards ?? []).filter(
      ({ label }) => label === 'Share of voice — consumer apps',
    );

    expect(card?.detail).toMatch(
      /citation rate across ChatGPT \(app\) and AI Mode$/,
    );
    expect(card?.headlineInterval?.counts).toMatch(
      /^Mentioned in \d of 4 planned answers; \d captured$/,
    );

    const standard = await presentVersion(2);

    expect(
      standard.sections.flatMap((s) => s.scorecards).map(({ label }) => label),
    ).not.toContain('Share of voice — consumer apps');
  });

  it('should round an interval outward to whole percents, and drop bounds out of order', async () => {
    const files = withSnapshot(await exportedFiles(), {
      summary: {
        // 0.07 * 100 is 7.000000000000001: a naive ceiling would show 8%.
        prospectShareOfVoiceEvidence: {
          ...{ count: 2, captured: 20, planned: 20 },
          ...{ low: 0.07, high: 0.93 },
        },
        prospectCitationRateEvidence: {
          ...{ count: 2, captured: 20, planned: 20 },
          ...{ low: 0.9, high: 0.1 },
        },
      },
    });
    const [card] = shown(presentReport(files)).sections[0]?.scorecards ?? [];

    expect(card?.headlineInterval?.text).toBe('approx. 95% interval 7–93%');
    expect(card?.detailInterval).toBeUndefined();
  });

  it("should name a surface by the snapshot's own label, and the others without (API)", async () => {
    const files = withSnapshot(await exportedFiles(), {
      meta: { surfaceLabels: { perplexity: '<b>Sonar</b>' } },
    });
    const [section] = shown(presentReport(files)).sections;

    expect(section?.surfaceRates.map((row) => row.surface)).toEqual([
      'ChatGPT',
      '<b>Sonar</b>',
    ]);
    expect(section?.matrix.assistantSurfaces).toEqual([
      'ChatGPT',
      '<b>Sonar</b>',
    ]);
  });

  it('should put the captured answers behind each matrix cell', async () => {
    const [section] = (await presentVersion(2)).sections;
    const [firstPrompt] = section?.matrix.rows ?? [];
    const absent = firstPrompt?.cells[1];

    expect(firstPrompt?.cells.map((cell) => cell.status)).toEqual([
      'no_data',
      'absent',
    ]);
    expect(absent?.runs).toHaveLength(2);
    expect(absent?.runs.every((run) => run.answer !== undefined)).toBe(true);
    expect(absent?.runs[0]).toMatchObject({
      surface: 'Perplexity',
      status: 'absent',
      mentionedBrands: ['rivalstack.test'],
      citedUrls: ['https://rivalstack.test/pricing'],
    });
  });

  it('should rank the alternatives and lead the cited domains with the brand', async () => {
    const [section] = (await presentVersion(2)).sections;

    expect(section?.alternatives).toEqual([
      {
        name: 'Rivalstack',
        domain: 'rivalstack.test',
        mentioning: 6,
        captured: 6,
        share: 1,
        percent: '100%',
      },
    ]);
    expect(
      section?.citedDomains.map(({ domain, count, hosts }) => ({
        domain,
        count,
        hosts,
      })),
    ).toEqual([
      {
        domain: 'acmebase.test',
        count: 2,
        hosts: [{ label: 'site', count: 2 }],
      },
      { domain: 'rivalstack.test', count: 2, hosts: undefined },
    ]);
  });

  it('should date a run that reused earlier captures by their whole span, and say how many it reused', async () => {
    const files = withSnapshot(await exportedFiles(), {
      meta: {
        reusedProbes: {
          count: 4,
          oldestCapturedAt: '2026-10-20T08:00:00.000Z',
        },
      },
    });
    const report = shown(presentReport(files));

    expect(report.hero.measuredOn).toBe('20 October 2026 to 1 November 2026');
    expect(report.footer.baseline).toMatch(
      /^Measured 20 October 2026 to 1 November 2026: /,
    );
    expect(report.footer.notes).toEqual([
      '4 answers were reused from an earlier capture, not asked again by this run.',
    ]);

    const undated = withSnapshot(await exportedFiles(), {
      meta: { reusedProbes: { count: 1, oldestCapturedAt: null } },
    });

    expect(shown(presentReport(undated)).hero.measuredOn).toBe(
      'by 1 November 2026',
    );
  });

  it('should claim inspectable raw answers only when the bundle holds them', async () => {
    const files = await exportedFiles();
    const withheld = new Map(files);

    withheld.delete('captures/units.json');

    expect(shown(presentReport(files)).hero.facts).toContain(
      'Raw answers preserved and inspectable',
    );
    expect(shown(presentReport(withheld)).hero.facts).not.toContain(
      'Raw answers preserved and inspectable',
    );
  });

  it('should keep the methodology the snapshot carries, as plain sentences', async () => {
    const files = withSnapshot(await exportedFiles(), {
      meta: {
        methodology: [
          'A rate is a share of the planned answers.',
          '<i>Never markup.</i>',
        ],
      },
    });

    expect(shown(presentReport(files)).footer.methodology).toEqual([
      'A rate is a share of the planned answers.',
      '<i>Never markup.</i>',
    ]);
  });

  it("should take the brand from the audit config when an earlier release's snapshot has none", async () => {
    const files = await exportedFiles();

    expect(shown(presentReport(files)).brand).toEqual({
      name: 'Acmebase',
      domain: 'acmebase.test',
    });

    const withoutConfig = new Map(files);

    withoutConfig.delete('inputs/config.json');
    expect(presentReport(withoutConfig)).toEqual({
      outcome: 'unreadable',
      reason:
        'Neither report/snapshot.json nor inputs/config.json names the audited brand.',
    });
  });

  it('should say when the report is missing or unreadable', async () => {
    const files = await exportedFiles();
    const missing = new Map(files);

    missing.delete(snapshotPath);

    expect(presentReport(missing)).toEqual({ outcome: 'missing' });
    expect(
      presentReport(
        new Map(files).set(snapshotPath, Buffer.from('{"a":1,"a":2}')),
      ),
    ).toEqual({
      outcome: 'unreadable',
      reason:
        'report/snapshot.json does not match the report contract of this release.',
    });
  });

  it("should open with the report copy's hero and introduction when the bundle carries copy", async () => {
    const narrative = (text: string) => ({
      kind: 'narrative',
      text,
      basisFactIds: ['metric:sov'],
      premises: [{ proposition: 'A premise.', basisFactIds: ['metric:sov'] }],
    });
    const copy = {
      intro: [narrative('Acmebase leads half of the answers it appears in.')],
      sections: { hosting: { subtitle: [] } },
      confidence: 0.8,
      hero: {
        title: narrative('Where AI answers put Acmebase'),
        subtitle: narrative('Two assistants, three questions.'),
      },
    };
    const files = new Map(await exportedFiles()).set(
      'report/copy.json',
      Buffer.from(JSON.stringify(copy)),
    );
    const report = shown(presentReport(files));

    expect(report.hero).toMatchObject({
      title: 'Where AI answers put Acmebase',
      subtitle: 'Two assistants, three questions.',
    });
    expect(report.intro).toEqual({
      heading: 'How AI engines see Acmebase',
      lead: 'Acmebase leads half of the answers it appears in.',
    });
  });
});
