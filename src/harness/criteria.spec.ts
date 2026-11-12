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
import { premiseVerifierInstructions } from '../agents/verifier';
import { allCriteria, criterionById, producerGuidance } from './criteria';

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

  it('should tell the writer and the premise verifier, in the same words, never to compare two rates', () => {
    const { guidance } = criterionById('unsupported_rate_comparison');
    const documents = copywriterDocuments({
      config: copyFixtureConfig,
      snapshot: copyFixtureSnapshot,
      catalog: buildFactCatalog({
        snapshot: copyFixtureSnapshot,
        config: copyFixtureConfig,
        runId: 'run-1',
      }),
    });

    expect(documents['CRITERIA.md']).toContain(
      `unsupported_rate_comparison (blocking): ${guidance}`,
    );
    expect(premiseVerifierInstructions).toContain(
      `unsupported_rate_comparison: ${guidance}`,
    );
    // Counts side by side stay allowed; the reader compares.
    expect(guidance).toContain('side by side');
  });

  it("should keep a rule of the copy premise check alone out of the analysis stages' criteria", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aeo-criteria-'));

    try {
      await materializeWorkdir({
        dir,
        config: copyFixtureConfig,
        captured: [],
        copyRules: '',
      });

      const criteria = readFileSync(path.join(dir, 'CRITERIA.md'), 'utf8');

      // What analyze, qualify and review read is what their own reviews
      // judge: a copy rule there would change their inputs for nothing.
      expect(criteria).toContain('## Producer guidance: copy');
      expect(criteria).toContain('unsupported_published_assertion');
      expect(criteria).not.toContain('unsupported_rate_comparison');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
