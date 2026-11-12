import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleManifestSchema, bundlePaths } from './contracts';
import { parseBundleJson } from './json';
import { readBundleSource } from './read';
import { verifyBundle } from './verify';

// ============================================================================
// Bundles exported by earlier releases (specs/aeo-method-release-spec.md
// §6.3, __fixtures__/frozen/README.md): each must keep verifying, recomputed
// with the arithmetic it was made with, however the current method changes.
// ============================================================================

const frozenDir = path.join(import.meta.dirname, '__fixtures__', 'frozen');

// Every check a synthetic run without a trace, grounding or copy can pass.
const expectedOutcomes = {
  'bundle.integrity': 'pass',
  'trace.chain': 'pass',
  'trace.coverage': 'not_checkable',
  'plan.accounted': 'pass',
  'judgments.evidence': 'pass',
  'metrics.recomputed': 'pass',
  'grounding.references': 'not_applicable',
  'copy.provenance': 'not_applicable',
  'lineage.predecessor': 'not_applicable',
  'bundle.redactions': 'not_applicable',
};

describe('verify - verifyBundle() over frozen bundles', () => {
  it.each([
    ['schema-1-0.2.0.aeo.zip', 1, 1],
    ['schema-2-12df4f5-depth-3.aeo.zip', 2, 1],
    ['schema-2-0.3.0.aeo.zip', 2, 1],
    ['schema-3-0.4.0.aeo.zip', 3, 2],
    ['schema-3-0.4.0-consumer-apps.aeo.zip', 3, 2],
  ])(
    'should verify %s, written with bundle schema %i and calculation version %i',
    async (name, bundleSchemaVersion, calculationVersion) => {
      const source = await readBundleSource(path.join(frozenDir, name));
      const verification = verifyBundle(source.files, source.description);
      const outcomes = Object.fromEntries(
        verification.checks.map((check) => [check.id, check.outcome]),
      );
      const manifest = bundleManifestSchema.parse(
        parseBundleJson(
          source.files.get(bundlePaths.manifest)?.toString('utf8') ?? '',
        ),
      );

      expect(manifest.bundleSchemaVersion).toBe(bundleSchemaVersion);
      expect(manifest.calculationVersion).toBe(calculationVersion);
      expect(outcomes).toEqual(expectedOutcomes);
      // Done, with the declared limitations of a run without a trace.
      expect(verification.exitCode).toBe(3);
    },
  );
});
