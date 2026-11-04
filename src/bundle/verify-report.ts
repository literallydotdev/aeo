import { z } from 'zod';
import { aggregateJudgments, metricsView } from '../codex-workflow/aggregate';
import { validateGroundingBundle } from '../grounding/validation';
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
  calculationVersion,
  type BundleManifest,
} from './contracts';
import { canonicalDigest } from './json';
import type { MeasurementInputs } from './verify-measurement';

// ============================================================================
// Checks 4 and 5 of specs/aeo-open-source-cli-spec.md §10: the report's
// numbers recomputed from the frozen judgments by the workflow's own
// aggregate step, compared before any display rounding, and the grounding
// and copy evidence the report rests on.
// ============================================================================

/** The value JSON.stringify would write: how the workflow saved what the
 * verifier recomputes (NaN becomes null, undefined keys disappear). */
const asWritten = (value: unknown): unknown => {
  return JSON.parse(JSON.stringify(value));
};

const aggregateDocumentSchema = z.looseObject({
  sections: z.record(z.string(), z.unknown()),
  unjudged: z.array(z.string()),
});
const snapshotDocumentSchema = z.looseObject({
  sections: z.array(
    z.looseObject({ key: z.string(), visibility: z.unknown() }),
  ),
});
const visibilityOfSchema = z.looseObject({ visibility: z.unknown() });

type MetricsCheckOptions = {
  manifest: BundleManifest;
  inputs: MeasurementInputs;
  judgments: { analyze: unknown; qualify: unknown };
  read: DocumentReader;
};

const recomputeProblems = (
  recomputed: ReturnType<typeof aggregateJudgments>,
  { inputs, read }: Pick<MetricsCheckOptions, 'inputs' | 'read'>,
  stored: z.infer<typeof aggregateDocumentSchema>,
): Problem[] => {
  const sections = aggregateDocumentSchema.parse(
    asWritten(recomputed),
  ).sections;
  const problems: Problem[] = [];
  const keys = new Set([
    ...Object.keys(sections),
    ...Object.keys(stored.sections),
  ]);

  for (const key of keys) {
    if (
      canonicalDigest(sections[key] ?? null) !==
      canonicalDigest(stored.sections[key] ?? null)
    ) {
      problems.push({
        code: 'section_metrics_mismatch',
        message: `Section ${key}'s stored results differ from the results its judgments yield.`,
        artifact: bundlePaths.aggregate,
      });
    }
  }

  if (
    canonicalDigest([...recomputed.unjudged].sort()) !==
    canonicalDigest([...stored.unjudged].sort())
  ) {
    problems.push({
      code: 'unjudged_mismatch',
      message:
        'The stored list of unjudged answers differs from the recomputed one.',
      artifact: bundlePaths.aggregate,
    });
  }

  const metrics = read(bundlePaths.metrics, z.unknown());
  const view = asWritten(metricsView(recomputed, inputs.config.brand.domain));

  if (
    'value' in metrics &&
    canonicalDigest(view) !== canonicalDigest(metrics.value)
  ) {
    problems.push({
      code: 'metrics_view_mismatch',
      message: 'The stored metrics differ from the recomputed ones.',
      artifact: bundlePaths.metrics,
    });
  }

  const snapshot = read(bundlePaths.snapshot, snapshotDocumentSchema);

  for (const section of 'value' in snapshot ? snapshot.value.sections : []) {
    const expected = visibilityOfSchema.safeParse(sections[section.key]);
    const visibility = expected.success ? expected.data.visibility : null;

    if (canonicalDigest(visibility) !== canonicalDigest(section.visibility)) {
      problems.push({
        code: 'snapshot_metrics_mismatch',
        message: `The report snapshot's ${section.key} visibility differs from the recomputed one.`,
        artifact: bundlePaths.snapshot,
      });
    }
  }

  return problems;
};

export const checkMetrics = ({
  manifest,
  inputs,
  judgments,
  read,
}: MetricsCheckOptions): Check => {
  const id = 'metrics.recomputed';
  const title = 'Metrics recomputed';

  if (manifest.calculationVersion !== calculationVersion) {
    return decidedCheck({
      id,
      title,
      outcome: CheckOutcome.UNSUPPORTED,
      code: 'calculation_version_unsupported',
      explanation: `The bundle uses calculation version ${manifest.calculationVersion}; this verifier implements version ${calculationVersion} only and does not recompute another method.`,
    });
  }

  const stored = read(bundlePaths.aggregate, aggregateDocumentSchema);

  if (!('value' in stored)) {
    return checkFrom({ id, title, problems: [stored.problem], pass: '' });
  }

  let recomputed: ReturnType<typeof aggregateJudgments>;

  try {
    recomputed = aggregateJudgments(
      {
        config: inputs.config,
        surfaces: inputs.plan.surfaces,
        capture: inputs.plan.capture,
        captured: inputs.captured,
      },
      judgments,
    );
  } catch (err) {
    const problem = {
      code: 'recompute_failed',
      message: `The accepted judgments cannot be aggregated: ${describeError(err)}`,
      artifact: bundlePaths.analyze,
    };

    return checkFrom({ id, title, problems: [problem], pass: '' });
  }

  const check = checkFrom({
    id,
    title,
    problems: recomputeProblems(recomputed, { inputs, read }, stored.value),
    pass: `Counts, denominators, share of voice, citations and competitor grouping for ${Object.keys(recomputed.sections).length} sections recompute exactly from the frozen judgments.`,
  });

  return check;
};

export const checkGrounding = (
  manifest: BundleManifest,
  read: DocumentReader,
): Check => {
  const id = 'grounding.references';
  const title = 'Evidence references';
  const grounding = read(bundlePaths.grounding, z.unknown());

  if ('problem' in grounding && grounding.problem.code === 'document_missing') {
    return decidedCheck({
      id,
      title,
      outcome: CheckOutcome.NOT_APPLICABLE,
      code: 'no_grounding',
      explanation: 'The run carries no grounding bundle.',
    });
  }

  if (!('value' in grounding)) {
    return checkFrom({ id, title, problems: [grounding.problem], pass: '' });
  }

  const problems: Problem[] = [];

  try {
    const bundle = validateGroundingBundle(grounding.value);

    if (bundle.runId !== undefined && bundle.runId !== manifest.run.id) {
      problems.push({
        code: 'grounding_run_mismatch',
        message: `The grounding bundle belongs to run ${bundle.runId}.`,
        artifact: bundlePaths.grounding,
      });
    }
  } catch (err) {
    problems.push({
      code: 'grounding_invalid',
      message: describeError(err),
      artifact: bundlePaths.grounding,
    });
  }

  return checkFrom({
    id,
    title,
    problems,
    pass: 'Grounding sources, passages and fact references resolve and their digests match. Claim verdicts are recorded model judgments, not repeated here.',
  });
};

export const checkCopy = (
  files: ReadonlyMap<string, Buffer>,
  read?: DocumentReader,
): Check => {
  const id = 'copy.provenance';
  const title = 'Copy provenance';
  const copy = read?.(bundlePaths.copy, z.unknown());

  if (copy && 'problem' in copy && copy.problem.code === 'document_withheld') {
    return checkFrom({ id, title, problems: [copy.problem], pass: '' });
  }

  if (!files.has(bundlePaths.copy)) {
    return decidedCheck({
      id,
      title,
      outcome: CheckOutcome.NOT_APPLICABLE,
      code: 'no_copy',
      explanation: 'The run carries no report copy.',
    });
  }

  return decidedCheck({
    id,
    title,
    outcome: CheckOutcome.NOT_CHECKABLE,
    code: 'copy_receipt_recorded',
    explanation:
      'The copy and its verifier receipt are a recorded model verdict; this version does not re-check copy receipts offline.',
  });
};
