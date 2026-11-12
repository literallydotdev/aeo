import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  testModelProfileFixture,
  testStageModelFixture,
} from '../models/profile-fixture';
import {
  copyFixtureConfig,
  copyFixtureSnapshot,
} from '../agents/__fixtures__/copy';
import { groundingFixture } from '../agents/__fixtures__/grounding';
import {
  assertCopyValidation,
  copyCheckerVersion,
  copyReceiptDigest,
  isStoredProvenance,
  premiseVerifierPromptVersion,
} from '../agents/copy-validation';
import { isRecord } from '../lib/type-guards';
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

      const verifierRole = testModelProfileFixture().roles.premiseVerifier;
      const grounding = groundingFixture();
      const result = await deliverableCopy(
        {
          dir,
          brand: copyFixtureConfig.brand,
          answers: [],
          stageModel: testStageModelFixture,
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

      // A receipt as 0.4.0 and every release before it issued one: checker
      // 7, under premise verifier prompt 3. It keeps validating the copy it
      // was issued for, whatever the verifier's prompt is now.
      const recordOf = (value: unknown) => {
        if (!isRecord(value)) {
          throw new Error('Expected the delivered copy to carry a record.');
        }

        return value;
      };
      const check = (earlier: { provenance: unknown; receipt: unknown }) => {
        return () =>
          assertCopyValidation({
            copy: result.copy,
            config: copyFixtureConfig,
            configVersion: 1,
            snapshot: copyFixtureSnapshot,
            runId: 'run-1',
            grounding,
            verifierProfile: verifierRole,
            ...earlier,
          });
      };
      const provenance: unknown = {
        ...recordOf(result.provenance),
        verifierPromptVersion: 3,
      };

      if (!isStoredProvenance(provenance)) {
        throw new Error('Expected a stored copy provenance.');
      }

      const issuedBefore = {
        ...recordOf(result.receipt),
        checkerVersion: 7,
        verifierPromptVersion: 3,
        digest: copyReceiptDigest(result.copy, provenance, 7),
      };

      expect(check({ provenance, receipt: issuedBefore })).not.toThrow();
      // Never read as issued under the current prompt.
      expect(
        check({
          provenance: result.provenance,
          receipt: { ...issuedBefore, verifierPromptVersion: 4 },
        }),
      ).toThrow('Copy validation receipt');
      expect(result.receipt).toMatchObject({
        checkerVersion: copyCheckerVersion,
        verifierPromptVersion: premiseVerifierPromptVersion,
      });
      expect(copyCheckerVersion).toBeGreaterThan(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
