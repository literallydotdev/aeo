import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { credentialDetected } from '../agents/credentials';
import { capturePlan } from '../capture-manifest';
import { codexGateway } from '../codex-workflow/codex-home';
import { stagePrompts } from '../codex-workflow/prompts';
import { readRunInputs, type RunInputs } from '../codex-workflow/run-inputs';
import { stageVersions } from '../codex-workflow/schemas';
import { hasErrorCode } from '../stores/fs-errors';
import {
  auditCopyFile,
  authorEvidenceFile,
  authorEvidenceSchema,
} from '../engine/run-configuration';
import { recordedCalculationVersion } from '../codex-workflow/aggregate';
import {
  bundlePaths,
  calculationVersion,
  measurementDigest,
  predecessorPrefix,
  readableCalculationVersions,
  type CalculationVersion,
  type PlanDocument,
} from './contracts';
import { isolationLimitations } from './isolation';
import { canonicalDigest, encodeBundleJson } from './json';
import { bundlePathError } from './paths';
import { predecessorDir, readDerivedFrom, type DerivedFrom } from './lineage';
import { projectJournal, type JournalProjection } from './project-journal';
import { capturedAnswerOf } from './trace-coverage';

// ============================================================================
// The projection from a work directory into bundle files
// (specs/aeo-open-source-cli-spec.md §8, §9): an allowlist of typed
// records, never a recursive copy. Answer text, judgments and outputs are
// kept faithfully; Codex homes, journals of raw CLI output, stage error text
// and anything else in the directory stay behind.
// ============================================================================

const readJson = async (dir: string, relative: string): Promise<unknown> => {
  const text = await readFile(path.join(dir, relative), 'utf8').catch(
    (err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) {
        return undefined;
      }

      throw err;
    },
  );

  return text === undefined ? undefined : JSON.parse(text);
};

const readText = async (dir: string, relative: string) => {
  const text = await readFile(path.join(dir, relative), 'utf8').catch(
    (err: unknown) => {
      if (hasErrorCode(err, 'ENOENT')) {
        return undefined;
      }

      throw err;
    },
  );

  return text;
};

const listJsonFiles = async (dir: string, relative: string) => {
  const entries = await readdir(path.join(dir, relative), {
    withFileTypes: true,
  }).catch((err: unknown) => {
    if (hasErrorCode(err, 'ENOENT')) {
      return [];
    }

    throw err;
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** Stage usage as STATE.json recorded it, without its error text: stderr
 * from a CLI is arbitrary shell diagnostics (spec §9). */
const stageUsage = (state: unknown) => {
  const stages =
    isRecord(state) && Array.isArray(state.stages) ? state.stages : [];

  return stages.filter(isRecord).map((stage) => ({
    stage: stage.stage ?? null,
    ok: stage.ok ?? null,
    at: stage.at ?? null,
    durationMs: stage.durationMs ?? null,
    usage: stage.usage ?? null,
  }));
};

const runPolicyOf = (request: RunInputs['request']) => {
  const runPolicy = {
    mode: request.mode,
    allowPartial: request.allowPartial,
    grounding: request.grounding,
    coverageThresholds: request.coverageThresholds,
    maxPlannedUnits: request.maxPlannedUnits,
    limits: request.limits,
    modelBudget: request.modelBudget ?? null,
  };

  return runPolicy;
};

/** The Codex stages' model as the run pinned it; null for a run whose
 * profile predates the stage model in the profile (its sessions record the
 * model they asked for in the journal). */
const stageModelOf = (inputs: RunInputs) => {
  const stages = inputs.request.modelProfile?.stages;

  return stages
    ? {
        model: stages.model,
        provider: codexGateway.providerName,
        reasoningEffort: stages.reasoningEffort,
      }
    : null;
};

const methodOf = async (
  dir: string,
  {
    inputs,
    snapshot,
    numbersMadeWith,
  }: {
    inputs: RunInputs;
    snapshot: unknown;
    numbersMadeWith: CalculationVersion;
  },
) => {
  const meta =
    isRecord(snapshot) && isRecord(snapshot.meta) ? snapshot.meta : {};
  const schemas: Record<string, unknown> = {};

  for (const name of await listJsonFiles(dir, 'SCHEMA')) {
    schemas[name.replace(/\.json$/, '')] = await readJson(
      dir,
      `SCHEMA/${name}`,
    );
  }

  const method = {
    version: 1,
    calculationVersion: numbersMadeWith,
    modelProfile: inputs.request.modelProfile ?? null,
    grounding: inputs.request.grounding,
    models: meta.models ?? null,
    analyzerVersion: meta.analyzerVersion ?? null,
    domainClassifierVersion: meta.domainClassifierVersion ?? null,
    competitorClassifierVersion: meta.competitorClassifierVersion ?? null,
    rules: {
      analysis: (await readText(dir, 'RULES/analysis.md')) ?? null,
      copy: (await readText(dir, 'RULES/copy.md')) ?? null,
      criteria: (await readText(dir, 'CRITERIA.md')) ?? null,
    },
    schemas,
    // The stage instructions every Codex session starts from, by value;
    // a session's own packet is in the journal.
    stagePrompts,
    stageVersions,
    codexModel: stageModelOf(inputs),
  };

  return method;
};

/** inputs/author/: how the configuration came to be, as the run recorded
 * it (spec §5): a hand-written config declares that no author history was
 * supplied; an authored one carries the author record and the diff. */
const authorDocuments = (evidence: unknown): [string, unknown][] => {
  const parsed = authorEvidenceSchema.safeParse(evidence);

  if (!parsed.success || parsed.data.kind === 'manual') {
    return [
      [
        bundlePaths.author,
        {
          version: 1,
          kind: 'not_supplied',
          reason: parsed.success
            ? 'audit.json names no author session: the configuration was written by hand.'
            : 'The work directory records no author revision; the configuration is the one the run was prepared with.',
        },
      ],
    ];
  }

  if (parsed.data.kind === 'record_missing') {
    return [
      [
        bundlePaths.author,
        {
          version: 1,
          kind: 'record_missing',
          reference: parsed.data.reference,
          reason:
            'audit.json names an author session whose record was not beside it, or did not match its digest.',
        },
      ],
    ];
  }

  return [
    [
      bundlePaths.author,
      {
        version: 1,
        kind: 'authored',
        reference: parsed.data.reference,
        unedited: parsed.data.unedited,
        note: 'Only the difference between the proposal and the final configuration is known, not the editing in between.',
      },
    ],
    [bundlePaths.authorRecord, parsed.data.record],
    [bundlePaths.authorDiff, parsed.data.diff],
  ];
};

const listFilesRecursively = async (
  dir: string,
  relative = '',
): Promise<string[]> => {
  const entries = await readdir(path.join(dir, relative), {
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(dir, file)));
    } else if (entry.isFile()) {
      files.push(file);
    }
  }

  return files.sort();
};

export type CredentialFinding = {
  path: string;
  kind: 'run_credential' | 'credential_pattern';
};

export type Projection = {
  inputs: RunInputs;
  derivedFrom: DerivedFrom | undefined;
  files: Map<string, Buffer>;
  digests: {
    measurement: string;
    runPolicy: string;
    method: string;
    plan: string;
  };
  /** The calculation version the run's numbers were made with. */
  calculationVersion: CalculationVersion;
  execution: 'completed' | 'incomplete';
  needsImprovement: boolean | null;
  findings: CredentialFinding[];
  journal: Omit<JournalProjection, 'files'>;
};

/**
 * projectWorkdir builds the bundle files of a work directory's current
 * state. It reads files only: no model call, no database, no network.
 */
export const projectWorkdir = async (
  dir: string,
  {
    secrets = [],
    eventLimit,
  }: { secrets?: readonly string[]; eventLimit?: number } = {},
): Promise<Projection> => {
  const inputs = await readRunInputs(dir);

  if (!inputs) {
    throw new Error(
      `Please prepare ${dir} again (pnpm aeo:codex prepare --report <reportKey> --workdir ${dir}); it predates INPUTS.json, which export needs. Preparing reuses every banked answer and runs no stage.`,
    );
  }

  const { config, request, surfaces, capture } = inputs;
  const snapshot = await readJson(dir, 'OUT/snapshot.json');
  const aggregate = await readJson(dir, 'OUT/aggregate.json');
  // The calculation version the published numbers were made with, as the
  // aggregate step recorded it (method release spec §6.3); never the
  // installed engine's. A directory with no aggregate has no numbers yet.
  const numbersMadeWith =
    aggregate === undefined
      ? calculationVersion
      : recordedCalculationVersion(aggregate);

  if (numbersMadeWith === undefined) {
    throw new Error(
      `${path.join(dir, 'OUT', 'aggregate.json')} names no calculation version this release reads (it reads ${readableCalculationVersions.join(' and ')}): a newer release made it, and exports it, or the file is damaged.`,
    );
  }
  const plan = capturePlan(config, surfaces, request.sections);
  const runPolicy = runPolicyOf(request);
  const method = await methodOf(dir, { inputs, snapshot, numbersMadeWith });
  // In the workflow's order: the aggregate assembles runs in record order,
  // so a reordered list would recompute a reordered matrix.
  const captured = inputs.captured;
  const derivedFrom = await readDerivedFrom(dir);
  const { files: journalFiles, ...journal } = await projectJournal(dir, {
    eventLimit,
    captured: captured.map(capturedAnswerOf),
    derived: derivedFrom !== undefined,
  });

  const documents = new Map<string, unknown>([
    [bundlePaths.config, config],
    [
      bundlePaths.plan,
      {
        version: 1,
        surfaces,
        sections: request.sections ?? null,
        plan,
        capture,
        runPolicy,
      } satisfies PlanDocument,
    ],
    [bundlePaths.method, method],
    ...authorDocuments(await readJson(dir, authorEvidenceFile)),
    [bundlePaths.auditFile, await readJson(dir, auditCopyFile)],
    [
      bundlePaths.runtime,
      {
        version: 1,
        writers: journal.writers,
        agentCliVersions: capture.agentCliVersions,
        isolation: journal.isolation,
        limitations:
          journal.writers.length > 0
            ? isolationLimitations(journal.isolation)
            : [
                'The work directory predates runtime recording; the writers of this run are unknown.',
              ],
      },
    ],
    [bundlePaths.captures, captured],
    [
      bundlePaths.captureManifest,
      await readJson(dir, 'OUT/capture-manifest.json'),
    ],
    [bundlePaths.analyze, await readJson(dir, 'OUT/analyze.json')],
    [bundlePaths.qualify, await readJson(dir, 'OUT/qualify.json')],
    [bundlePaths.review, await readJson(dir, 'OUT/review.json')],
    [bundlePaths.corrections, await readJson(dir, 'OUT/corrections.json')],
    [bundlePaths.aggregate, aggregate],
    [bundlePaths.metrics, await readJson(dir, 'METRICS.json')],
    [bundlePaths.snapshot, snapshot],
    [bundlePaths.labels, await readJson(dir, 'OUT/labels.json')],
    [
      bundlePaths.partialFailures,
      await readJson(dir, 'OUT/partial-failures.json'),
    ],
    [bundlePaths.copy, await readJson(dir, 'OUT/write.json')],
    [bundlePaths.scorecard, await readJson(dir, 'SCORECARD.json')],
    [
      bundlePaths.usage,
      {
        version: 1,
        stages: stageUsage(await readJson(dir, 'STATE.json')),
        hostModelLedger: null,
        knownSpendUsd: null,
        limitations: [
          'Codex stage tokens are recorded per stage as the scorecard saw them; host model spend, reservations and provider receipts were not recorded in the work directory.',
        ],
      },
    ],
  ]);

  const grounding = await readJson(dir, 'OUT/grounding.json');

  if (grounding !== null && grounding !== undefined) {
    documents.set(bundlePaths.grounding, grounding);
  }

  for (const name of await listJsonFiles(dir, 'REVIEW')) {
    const target = `analysis/review-rounds/${name}`;

    if (bundlePathError(target) === undefined) {
      documents.set(target, await readJson(dir, `REVIEW/${name}`));
    }
  }

  const files = new Map<string, Buffer>();

  for (const [target, value] of documents) {
    if (value !== undefined) {
      files.set(target, encodeBundleJson(value));
    }
  }

  // A run that has no journal exports an empty one: past events are never
  // manufactured (spec §13, Phase 1).
  for (const [target, bytes] of journalFiles) {
    files.set(target, bytes);
  }

  // The predecessor travels byte for byte, so its own manifest verifies.
  if (derivedFrom) {
    const predecessor = path.join(dir, predecessorDir, derivedFrom.revisionId);

    for (const relative of await listFilesRecursively(predecessor)) {
      files.set(
        `${predecessorPrefix(derivedFrom.revisionId)}${relative}`,
        await readFile(path.join(predecessor, relative)),
      );
    }
  }

  const findings: CredentialFinding[] = [];

  for (const [target, bytes] of files) {
    const text = bytes.toString('utf8');

    if (
      credentialDetected(text, secrets, {
        includePatterns: false,
      })
    ) {
      findings.push({ path: target, kind: 'run_credential' });
    } else if (credentialDetected(text)) {
      findings.push({ path: target, kind: 'credential_pattern' });
    }
  }

  const quality =
    isRecord(snapshot) &&
    isRecord(snapshot.meta) &&
    isRecord(snapshot.meta.quality)
      ? snapshot.meta.quality
      : undefined;

  const projection: Projection = {
    inputs,
    files,
    digests: {
      measurement: measurementDigest({
        config,
        surfaces,
        sections: request.sections ?? null,
      }),
      runPolicy: canonicalDigest(runPolicy),
      method: canonicalDigest(method),
      plan: plan.digest,
    },
    calculationVersion: numbersMadeWith,
    execution: snapshot === undefined ? 'incomplete' : 'completed',
    needsImprovement:
      typeof quality?.needsImprovement === 'boolean'
        ? quality.needsImprovement
        : null,
    findings,
    journal,
    derivedFrom,
  };

  return projection;
};
