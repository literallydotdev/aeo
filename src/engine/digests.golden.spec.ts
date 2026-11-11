import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectWorkdir } from '../bundle/project';
import { runInputsFile, runInputsSchema } from '../codex-workflow/run-inputs';
import { auditFileSchema, toRunRequest } from './audit-file';
import { planLocalRun } from './local-run';

// ============================================================================
// Golden pins of a measurement's identity (probe adapters spec §7, phase 1):
// the absolute plan, measurement and run-policy digests of one fixed
// audit.json, as a local run plans it and as the bundle export computes
// them. engine.spec.ts compares digests with each other; these pin their
// values. A digest that moves is a method change (or, for run policy, a
// policy change) to make on purpose and state, never a pin to update.
// ============================================================================

const fixedAuditFile = auditFileSchema.parse({
  version: 1,
  brand: { name: 'Acme Files', domain: 'acme.example', aliases: ['Acme'] },
  competitors: [{ name: 'Rival Files', domain: 'rival.example', aliases: [] }],
  sections: [
    {
      key: 'file_stores',
      prompts: [
        {
          id: 'fs1',
          text: 'Which managed file store suits a small engineering team?',
          category: 'product_recommendation',
        },
        {
          id: 'fs2',
          text: 'What is the cheapest way to share large files with clients?',
          category: 'problem_solving',
        },
      ],
    },
  ],
  surfaces: [
    'chatgpt',
    'gemini',
    'claude',
    'perplexity',
    'google_ai_overview',
    'claude_code',
    'codex',
    'cursor',
  ],
  agentProbes: { runsPerPrompt: 1, maxPromptsPerSection: 1 },
  moneyPages: ['https://acme.example/pricing'],
  productBrief: 'Acme Files is a fictional managed file store.',
  runPolicy: { maxPlannedUnits: 100, budget: { maxHours: 12 } },
});

// The frozen budget a run directory would hold (budget.ts).
const fixedModelBudget = {
  maxUsd: 25,
  maxTokens: 2_000_000,
  deadlineAt: '2026-11-08T12:00:00.000Z',
};

// Recorded from 0.2.2.
const pinnedDigests = {
  measurement:
    '5d7afa5822993973b7e3da82063977bf1f0a9bb77eae8b0f8c788239f9717a54',
  plan: 'a6ff63ad014a4580dee298f9f27d40dd11d9a8819495cb3f6caeef1988132708',
  runPolicy: 'a840318c9971c06e9b24c609e3578011bf92221ce1f35e4b1a8c331fad1052bc',
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-golden-digests-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('local-run - planLocalRun() golden pins', () => {
  it('should plan the fixed audit.json under its pinned measurement and plan digests', () => {
    const planned = planLocalRun(fixedAuditFile, 'golden-run');

    expect(planned.digests).toEqual({
      measurement: pinnedDigests.measurement,
      plan: pinnedDigests.plan,
    });
  });
});

describe('project - projectWorkdir() golden pins', () => {
  it('should export the fixed audit.json run under its pinned measurement, plan and run-policy digests', async () => {
    const planned = planLocalRun(fixedAuditFile, 'golden-run');
    const inputs = runInputsSchema.parse({
      version: 1,
      reportKey: planned.config.reportKey,
      runId: 'golden-run',
      config: planned.config,
      request: toRunRequest(fixedAuditFile, 'golden-run', {
        modelBudget: fixedModelBudget,
      }),
      surfaces: planned.plan.surfaces,
      capture: {
        version: 1,
        reportKey: planned.config.reportKey,
        runId: 'golden-run',
        planDigest: '0'.repeat(64),
        plannedUnits: planned.plan.units.length,
        surfaces: planned.plan.surfaces,
        sections: {},
        failedSections: [],
        resumed: { count: 0, total: 0, oldestCapturedAt: null },
        agentCliVersions: { claudeCode: null, codex: null, cursor: null },
        startedAt: '2026-11-08T10:00:00.000Z',
        completedAt: '2026-11-08T11:00:00.000Z',
      },
      captured: [],
    });

    await writeFile(path.join(root, runInputsFile), JSON.stringify(inputs));
    const projection = await projectWorkdir(root);

    expect({
      measurement: projection.digests.measurement,
      plan: projection.digests.plan,
      runPolicy: projection.digests.runPolicy,
    }).toEqual(pinnedDigests);
  });
});
