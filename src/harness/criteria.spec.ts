import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeWorkdir } from '../codex-workflow/workdir';
import { copywriterDocuments } from '../agents/copywriter-input';
import {
  copyFixtureConfig,
  copyFixtureSnapshot,
} from '../agents/__fixtures__/copy';
import { buildFactCatalog } from '../agents/facts';
import { allCriteria, producerGuidance } from './criteria';

// One registry, three readers: the reviewers judge by it, and the Codex
// analyze stage and the writer are instructed from it, so a stage can no
// longer be told to produce what its reviewer will refuse.

describe('criteria - producerGuidance()', () => {
  it('should give every criterion producer guidance', () => {
    for (const criterion of allCriteria()) {
      expect(criterion.guidance.length, criterion.id).toBeGreaterThan(20);
    }
  });

  it('should write the attribution rule the reviewers enforce into the analysis rules', async () => {
    const analysis = producerGuidance('analysis');
    const dir = mkdtempSync(path.join(tmpdir(), 'aeo-criteria-'));

    expect(analysis[0]).toMatch(/^false_product_attribution \(blocking\)/);

    try {
      await materializeWorkdir({
        dir,
        config: copyFixtureConfig,
        captured: [],
        copyRules: '',
      });

      const rules = readFileSync(
        path.join(dir, 'RULES', 'analysis.md'),
        'utf8',
      );

      expect(rules).toContain('behind another vendor');
      for (const line of analysis) {
        expect(rules).toContain(line);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should hand the writer the copy criteria, blocking first, as a document', () => {
    const documents = copywriterDocuments({
      config: copyFixtureConfig,
      snapshot: copyFixtureSnapshot,
      catalog: buildFactCatalog({
        snapshot: copyFixtureSnapshot,
        config: copyFixtureConfig,
        runId: 'run-1',
      }),
    });

    const criteria = documents['CRITERIA.md'];

    expect(criteria).toContain('unsupported_published_assertion (blocking)');
    expect(criteria).toContain('buyer behaviour');
    expect(criteria).toContain('never "Literally.dev measured"');
    expect(criteria.indexOf('(blocking)')).toBeLessThan(
      criteria.indexOf('style_preference (advisory)'),
    );
  });
});
