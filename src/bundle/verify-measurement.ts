import { z } from 'zod';
import { locateVerbatimPassage } from '../analysis/verbatim';
import { capturePlan, validateCaptureManifest } from '../capture-manifest';
import { capturedRecordsSchema } from '../codex-workflow/run-inputs';
import {
  analyzeRowSchema,
  qualifyOutputSchema,
} from '../codex-workflow/schemas';
import { answerBody, answerFilePath } from '../codex-workflow/workdir';
import { unitRecordKey } from '../lib/checkpoint';
import { aeoAuditConfigSchema, type AeoAuditConfig } from '../schema';
import { contentHash } from '../stores/content-hash';
import type { CapturedUnitRecord } from '../stores/ports';
import {
  CheckOutcome,
  checkFrom,
  decidedCheck,
  describeError,
  type Check,
  type DocumentReader,
  type Problem,
} from './checks';
import {
  bundlePaths,
  measurementDigest,
  planDocumentSchema,
  type BundleManifest,
  type PlanDocument,
} from './contracts';
import { canonicalDigest } from './json';

// ============================================================================
// Checks 2 and 3 of specs/aeo-open-source-cli-spec.md §10: the plan rebuilt
// from the frozen configuration with every slot accounted for, and judgment
// coverage with verbatim evidence.
// ============================================================================

export type MeasurementInputs = {
  config: AeoAuditConfig;
  plan: PlanDocument;
  captured: CapturedUnitRecord[];
};

type PlanCheck = {
  check: Check;
  inputs?: MeasurementInputs;
  unknownSlots: number;
};

const slotKey = (unit: {
  sectionKey: string;
  promptId: string;
  surface: string;
  runIndex: number;
}) => {
  return `${unit.sectionKey}|${unit.promptId}|${unit.surface}|${unit.runIndex}`;
};

const slotName = (record: CapturedUnitRecord) => {
  return `${record.sectionKey}/${record.promptId}/${record.surface}-${record.runIndex}`;
};

const digestProblems = (
  manifest: BundleManifest,
  inputs: MeasurementInputs,
  method: unknown,
): Problem[] => {
  const { config, plan } = inputs;
  const recomputed = capturePlan(
    config,
    plan.surfaces,
    plan.sections ?? undefined,
  );
  const problems: Problem[] = [];

  if (
    recomputed.digest !== plan.plan.digest ||
    recomputed.digest !== manifest.digests.plan
  ) {
    problems.push({
      code: 'plan_mismatch',
      message:
        'The frozen plan is not the plan the frozen configuration produces.',
      artifact: bundlePaths.plan,
    });
  }

  const measurement = measurementDigest({
    config,
    surfaces: plan.surfaces,
    sections: plan.sections,
  });

  if (measurement !== manifest.digests.measurement) {
    problems.push({
      code: 'measurement_digest_mismatch',
      message: 'The measurement inputs do not match the manifest digest.',
      artifact: bundlePaths.config,
    });
  }

  if (canonicalDigest(plan.runPolicy) !== manifest.digests.runPolicy) {
    problems.push({
      code: 'run_policy_digest_mismatch',
      message: 'The run policy does not match the manifest digest.',
      artifact: bundlePaths.plan,
    });
  }

  if (canonicalDigest(method) !== manifest.digests.method) {
    problems.push({
      code: 'method_digest_mismatch',
      message: 'The method does not match the manifest digest.',
      artifact: bundlePaths.method,
    });
  }

  return problems;
};

const captureProblems = (
  inputs: MeasurementInputs,
  read: DocumentReader,
): Problem[] => {
  const { captured, plan } = inputs;
  const problems: Problem[] = [];

  for (const [sectionKey, section] of Object.entries(plan.capture.sections)) {
    const records = captured.filter(
      (record) => record.sectionKey === sectionKey,
    );

    for (const coverage of section.coverage) {
      const count = records.filter(
        (record) => record.surface === coverage.surface,
      ).length;

      if (count !== coverage.captured) {
        problems.push({
          code: 'coverage_count_mismatch',
          message: `Section ${sectionKey} records ${coverage.captured} ${coverage.surface} captures; the bundle holds ${count}.`,
          artifact: bundlePaths.captures,
        });
      }
    }

    const held = records.map((record) => contentHash(record.probe.text)).sort();
    const declared = section.units.map((unit) => unit.rawDigest).sort();

    if (canonicalDigest(held) !== canonicalDigest(declared)) {
      problems.push({
        code: 'capture_artifact_mismatch',
        message: `Section ${sectionKey}'s captured answers do not match the digests the capture recorded.`,
        artifact: bundlePaths.captures,
      });
    }
  }

  const document = read(bundlePaths.captureManifest, z.unknown());

  if (!('value' in document)) {
    return problems;
  }

  try {
    const captureManifest = validateCaptureManifest(document.value);
    const digestByKey = new Map(
      captured.map((record) => [
        unitRecordKey(record),
        contentHash(record.probe.text),
      ]),
    );

    for (const entry of captureManifest.captures) {
      if (digestByKey.get(entry.id) !== entry.rawDigest) {
        problems.push({
          code: 'capture_manifest_mismatch',
          message: `Capture manifest entry ${entry.id} does not match the captured answer.`,
          artifact: bundlePaths.captureManifest,
        });
      }
    }
  } catch (err) {
    problems.push({
      code: 'capture_manifest_invalid',
      message: describeError(err),
      artifact: bundlePaths.captureManifest,
    });
  }

  return problems;
};

export const checkPlan = (
  manifest: BundleManifest,
  read: DocumentReader,
): PlanCheck => {
  const id = 'plan.accounted';
  const title = 'Planned slots accounted';
  const config = read(bundlePaths.config, aeoAuditConfigSchema);
  const plan = read(bundlePaths.plan, planDocumentSchema);
  const captured = read(bundlePaths.captures, capturedRecordsSchema);
  const method = read(bundlePaths.method, z.unknown());

  if (
    !('value' in config) ||
    !('value' in plan) ||
    !('value' in captured) ||
    !('value' in method)
  ) {
    const problems = [config, plan, captured, method].flatMap((result) =>
      'problem' in result ? [result.problem] : [],
    );

    return {
      check: checkFrom({ id, title, problems, pass: '' }),
      unknownSlots: 0,
    };
  }

  const inputs = {
    config: config.value,
    plan: plan.value,
    captured: captured.value,
  };
  const problems = digestProblems(manifest, inputs, method.value);
  const units = capturePlan(
    inputs.config,
    inputs.plan.surfaces,
    inputs.plan.sections ?? undefined,
  ).units;
  const planned = new Set(units.map(unitRecordKey));
  const capturedKeys = new Set<string>();

  for (const record of inputs.captured) {
    const key = unitRecordKey(record);

    if (!planned.has(key)) {
      problems.push({
        code: 'capture_unplanned',
        message: `A capture is outside the plan: ${slotName(record)}.`,
        artifact: bundlePaths.captures,
      });
    }

    if (capturedKeys.has(key)) {
      problems.push({
        code: 'capture_duplicate',
        message: `A slot is captured twice: ${slotName(record)}.`,
        artifact: bundlePaths.captures,
      });
    }

    capturedKeys.add(key);
  }

  problems.push(...captureProblems(inputs, read));

  const failedSlots = new Set(
    Object.entries(inputs.plan.capture.sections).flatMap(
      ([sectionKey, section]) =>
        section.unitFailures.map((failure) =>
          slotKey({ sectionKey, ...failure }),
        ),
    ),
  );
  const unknownSlots = units.filter(
    (unit) =>
      !capturedKeys.has(unitRecordKey(unit)) && !failedSlots.has(slotKey(unit)),
  ).length;
  const accounting = `${units.length} planned slots: ${capturedKeys.size} captured, ${failedSlots.size} failed, ${unknownSlots} not attempted or unknown.`;

  // Unknown slots are a localized omission, not a forgery: the run may have
  // stopped before them. They are disclosed, never counted as captured.
  const check =
    problems.length === 0 && unknownSlots > 0
      ? decidedCheck({
          id,
          title,
          outcome: CheckOutcome.NOT_CHECKABLE,
          code: 'slots_unknown',
          explanation: accounting,
        })
      : checkFrom({ id, title, problems, pass: accounting });

  return { check, inputs, unknownSlots };
};

const analyzeDocumentSchema = z.object({ rows: z.array(analyzeRowSchema) });

type JudgmentCheck = {
  check: Check;
  judgments?: { analyze: unknown; qualify: unknown };
  unjudged?: number;
  corrections?: number;
};

export const checkJudgments = (
  inputs: MeasurementInputs,
  read: DocumentReader,
): JudgmentCheck => {
  const id = 'judgments.evidence';
  const title = 'Judgment coverage and evidence';
  const analyze = read(bundlePaths.analyze, analyzeDocumentSchema);
  const qualify = read(bundlePaths.qualify, qualifyOutputSchema);

  if (!('value' in analyze) || !('value' in qualify)) {
    const problems = [analyze, qualify].flatMap((result) =>
      'problem' in result ? [result.problem] : [],
    );

    return { check: checkFrom({ id, title, problems, pass: '' }) };
  }

  const problems: Problem[] = [];
  const recordByFile = new Map(
    inputs.captured.map((record) => [answerFilePath(record), record]),
  );
  const judged = new Set<string>();

  for (const row of analyze.value.rows) {
    if (!recordByFile.has(row.file)) {
      problems.push({
        code: 'judgment_unknown_answer',
        message: `An analysis row judges ${row.file}, which is not a captured answer.`,
        artifact: bundlePaths.analyze,
      });
    }

    if (judged.has(row.file)) {
      problems.push({
        code: 'judgment_duplicate',
        message: `${row.file} is judged twice.`,
        artifact: bundlePaths.analyze,
      });
    }

    judged.add(row.file);
  }

  for (const row of qualify.value.rows) {
    const record = recordByFile.get(row.file);

    if (!record) {
      problems.push({
        code: 'judgment_unknown_answer',
        message: `A qualification row names ${row.file}, which is not a captured answer.`,
        artifact: bundlePaths.qualify,
      });
      continue;
    }

    const body = answerBody(record.probe.text);

    for (const entry of row.qualifiedCompetitors) {
      if (locateVerbatimPassage(body, entry.quote.trim()) === null) {
        problems.push({
          code: 'quote_not_verbatim',
          message: `The evidence for ${entry.name} in ${row.file} is not verbatim in the answer body.`,
          artifact: bundlePaths.qualify,
        });
      }
    }
  }

  const unjudged = [...recordByFile.keys()].filter(
    (file) => !judged.has(file),
  ).length;
  const corrections = read(bundlePaths.corrections, z.array(z.unknown()));

  const result: JudgmentCheck = {
    check: checkFrom({
      id,
      title,
      problems,
      pass: `${judged.size} answers judged, ${unjudged} unjudged; every qualification quote is verbatim in its answer body.`,
    }),
    judgments: { analyze: analyze.value, qualify: qualify.value },
    unjudged,
    ...('value' in corrections && { corrections: corrections.value.length }),
  };

  return result;
};
