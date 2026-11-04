import { contentHash } from '../../stores/content-hash';
import type { AdmissionManifest, ApprovedRunManifest } from '../contracts';
import { workflowVersion } from '../../codex-workflow/schemas';
import { defaultHarnessPolicy, harnessPolicyDigest } from '../policy';

export const admissionFixture = (
  overrides: Partial<AdmissionManifest> = {},
): AdmissionManifest => {
  return {
    version: 1,
    pipelineId: 'pipe-1',
    reportKey: 'synthetic',
    tenantScope: 'operator',
    briefDigest: contentHash('brief'),
    intent: 'report',
    modelProfileId: 'test-profile-v1',
    modelProfileDigest: contentHash('profile'),
    harnessVersion: 1,
    graphVersion: workflowVersion,
    rubricVersion: 1,
    policyDigest: harnessPolicyDigest(defaultHarnessPolicy()),
    imageDigest: null,
    gates: { config: 'human', copy: 'human', publish: 'human' },
    audience: 'client_private',
    copyOwnership: 'agent',
    rootBudget: {
      maxUsd: 100,
      maxTokens: 5_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    },
    scopeCeilingUnits: 400,
    admittedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
};

export const approvedRunFixture = (
  admissionDigest: string,
  overrides: Partial<ApprovedRunManifest> = {},
): ApprovedRunManifest => {
  return {
    version: 1,
    admissionDigest,
    reportKey: 'synthetic',
    configVersion: 1,
    configDigest: contentHash('config'),
    runId: '01J0000000000000000000RUN1',
    measurementOrigin: 'fresh',
    questionSetDigest: contentHash('questions'),
    plannedUnits: 12,
    surfaces: ['chatgpt', 'gemini'],
    collectionWindowHours: 168,
    remainingBudgetCheckedAt: '2026-09-11T00:00:00.000Z',
    approvedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
};
