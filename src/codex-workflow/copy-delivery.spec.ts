import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  copyFixtureConfig,
  copyFixtureSnapshot,
} from '../agents/__fixtures__/copy';
import { groundingFixture } from '../agents/__fixtures__/grounding';
import { assertCopyValidation } from '../agents/copy-validation';
import { resolveInternalModelProfile } from '../models/profiles';
import { deliverableCopy } from './loop';

describe('Loop - deliverableCopy()', () => {
  it('should deliver frozen facts after copy review exhaustion with a valid publication receipt and improvement details', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeo-fact-delivery-'));

    try {
      await mkdir(path.join(dir, 'OUT'));
      await writeFile(
        path.join(dir, 'OUT/snapshot.json'),
        JSON.stringify(copyFixtureSnapshot),
      );

      const verifierRole = resolveInternalModelProfile().roles.premiseVerifier;
      const grounding = groundingFixture();
      const result = await deliverableCopy(
        {
          dir,
          brand: copyFixtureConfig.brand,
          answers: [],
          secrets: [],
          log: () => {},
        },
        {
          config: copyFixtureConfig,
          runId: 'run-1',
          configVersion: 1,
          grounding,
          verifierRole,
        },
        {
          stage: 'write',
          model: 'test',
          ok: false,
          durationMs: 0,
          usage: null,
          degraded: [],
          errors: ['Headline still has unsupported wording'],
          summary: { attempts: 5 },
        },
      );

      expect(result.quality).toMatchObject({
        needsImprovement: true,
        reviewRounds: 5,
      });
      expect(result.copy.intro).toContain(
        `captured ${copyFixtureSnapshot.meta.probeCount} answers`,
      );
      expect(result.copy.intro).not.toContain('in progress');

      const receipt = assertCopyValidation({
        copy: result.copy,
        provenance: result.provenance,
        receipt: result.receipt,
        config: copyFixtureConfig,
        configVersion: 1,
        snapshot: copyFixtureSnapshot,
        runId: 'run-1',
        grounding,
        verifierProfile: verifierRole,
      });

      expect(receipt.verifierModel).toBe('no-recommendations');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
