import { z } from 'zod';
import {
  CheckOutcome,
  checkFrom,
  createDocumentReader,
  decidedCheck,
  describeError,
  type Check,
  type Problem,
} from './checks';
import {
  bundleManifestSchema,
  bundlePaths,
  canonicalization,
  predecessorPrefix,
  readableBundleSchemaVersions,
  traceSchemaVersion,
  type BundleManifest,
} from './contracts';
import { parseBundleJson } from './json';
import { capturedAnswerOf } from './trace-coverage';
import {
  checkIntegrity,
  checkTraceChain,
  checkTraceCoverage,
} from './verify-integrity';
import { checkJudgments, checkPlan } from './verify-measurement';
import { checkCopy, checkGrounding, checkMetrics } from './verify-report';

// ============================================================================
// Offline verification (specs/aeo-open-source-cli-spec.md §10). Reads only
// the bundle: no key, no fetch, no provider, no bundled code, and never the
// producer's own "valid" flag. Each check reports separately; a bundle can
// be arithmetically sound and still carry unjudged answers or an empty
// trace, and capture authenticity is always reported as declared.
// ============================================================================

export type Verification = {
  verificationVersion: 1;
  source: string;
  bundle: {
    runId: string;
    revisionId: string;
    measurementId: string;
    origin: BundleManifest['run']['origin'];
    captureAuthenticity: BundleManifest['run']['captureAuthenticity'];
    execution: BundleManifest['run']['execution'];
    needsImprovement: boolean | null;
    bundleDigest: string;
  } | null;
  checks: Check[];
  disclosures: {
    capturedAnswers: number | null;
    capturesWithoutReportedModel: number | null;
    unjudgedAnswers: number | null;
    recordedCorrections: number | null;
    acceptedFindings: number | null;
    traceCoverage: BundleManifest['trace']['coverage'] | null;
    limitations: string[];
  };
  exitCode: 0 | 1 | 2 | 3;
};

/** Failure outranks an unsupported format, which outranks a localized
 * omission (spec §4.3). Self-reported authenticity alone is no warning. */
const exitCodeOf = (checks: readonly Check[]): Verification['exitCode'] => {
  const outcomes = new Set(checks.map((check) => check.outcome));

  if (outcomes.has(CheckOutcome.FAIL)) {
    return 1;
  }

  if (outcomes.has(CheckOutcome.UNSUPPORTED)) {
    return 2;
  }

  if (outcomes.has(CheckOutcome.NOT_CHECKABLE)) {
    return 3;
  }

  return 0;
};

/** The verification of something that could not be read as a bundle. */
export const refusedVerification = (
  source: string,
  check: Check,
): Verification => {
  return {
    verificationVersion: 1,
    source,
    bundle: null,
    checks: [check],
    disclosures: {
      capturedAnswers: null,
      capturesWithoutReportedModel: null,
      unjudgedAnswers: null,
      recordedCorrections: null,
      acceptedFindings: null,
      traceCoverage: null,
      limitations: [],
    },
    exitCode: exitCodeOf([check]),
  };
};

const integrityFailure = (code: string, message: string): Check => {
  return checkFrom({
    id: 'bundle.integrity',
    title: 'Bundle integrity',
    problems: [{ code, message, artifact: bundlePaths.manifest }],
    pass: '',
  });
};

const versionsSchema = z.looseObject({
  bundleSchemaVersion: z.unknown(),
  traceSchemaVersion: z.unknown(),
  canonicalization: z.unknown(),
});

/** readManifest returns the manifest, or the check that refuses it. */
const readManifest = (
  files: ReadonlyMap<string, Buffer>,
): { manifest: BundleManifest } | { refusal: Check } => {
  const bytes = files.get(bundlePaths.manifest);

  if (bytes === undefined) {
    return {
      refusal: integrityFailure(
        'manifest_missing',
        'The bundle has no manifest.json.',
      ),
    };
  }

  let parsed: unknown;

  try {
    parsed = parseBundleJson(bytes.toString('utf8'));
  } catch (err) {
    return {
      refusal: integrityFailure(
        'manifest_malformed',
        `manifest.json is not valid JSON: ${describeError(err)}`,
      ),
    };
  }

  const versions = versionsSchema.safeParse(parsed);
  const declared = versions.success
    ? [
        versions.data.bundleSchemaVersion,
        versions.data.traceSchemaVersion,
        versions.data.canonicalization,
      ]
    : [];

  if (
    !readableBundleSchemaVersions.some((version) => version === declared[0]) ||
    declared[1] !== traceSchemaVersion ||
    declared[2] !== canonicalization
  ) {
    return {
      refusal: decidedCheck({
        id: 'bundle.integrity',
        title: 'Bundle integrity',
        outcome: CheckOutcome.UNSUPPORTED,
        code: 'bundle_version_unsupported',
        explanation: `This verifier reads bundle schema ${readableBundleSchemaVersions.join(' or ')}, trace schema ${traceSchemaVersion} and ${canonicalization}; the bundle declares ${JSON.stringify(declared)}. It does not download or upgrade code to read another: verify the bundle with the literally-aeo release that produced it, or a newer one.`,
      }),
    };
  }

  const manifest = bundleManifestSchema.safeParse(parsed);

  if (!manifest.success) {
    return {
      refusal: integrityFailure(
        'manifest_invalid',
        `manifest.json does not match the bundle schema: ${manifest.error.message.slice(0, 300)}`,
      ),
    };
  }

  return { manifest: manifest.data };
};

const notRecomputed = (code: string, explanation: string): Check => {
  return decidedCheck({
    id: 'metrics.recomputed',
    title: 'Metrics recomputed',
    outcome: CheckOutcome.NOT_CHECKABLE,
    code,
    explanation,
  });
};

/** A rejudgment carries the revision it derives from; that revision must
 * verify on its own and be the one the manifest names (spec §8). */
const checkLineage = (
  files: ReadonlyMap<string, Buffer>,
  manifest: BundleManifest,
): Check => {
  const id = 'lineage.predecessor';
  const title = 'Predecessor revision';
  const derived = manifest.run.derivedFrom;

  if (!derived) {
    return decidedCheck({
      id,
      title,
      outcome: CheckOutcome.NOT_APPLICABLE,
      code: 'not_derived',
      explanation: 'The run is not derived from another revision.',
    });
  }

  const prefix = predecessorPrefix(derived.revisionId);
  const predecessorFiles = new Map(
    [...files]
      .filter(([file]) => file.startsWith(prefix))
      .map(([file, bytes]) => [file.slice(prefix.length), bytes]),
  );
  const nested = verifyBundle(
    predecessorFiles,
    `predecessor ${derived.revisionId}`,
  );
  const problems: Problem[] = [];

  if (!nested.bundle) {
    problems.push({
      code: 'predecessor_missing',
      message: `The bundle does not carry revision ${derived.revisionId} it derives from.`,
    });
  } else {
    if (
      nested.bundle.bundleDigest !== derived.bundleDigest ||
      nested.bundle.runId !== derived.runId
    ) {
      problems.push({
        code: 'predecessor_mismatch',
        message:
          'The carried predecessor is not the revision the manifest names.',
      });
    }

    if (nested.bundle.measurementId !== manifest.run.measurementId) {
      problems.push({
        code: 'measurement_lineage_mismatch',
        message: 'The predecessor belongs to another measurement.',
      });
    }

    if (nested.checks.some((check) => check.outcome === CheckOutcome.FAIL)) {
      problems.push({
        code: 'predecessor_failed',
        message: `The predecessor fails its own verification: ${nested.checks
          .filter((check) => check.outcome === CheckOutcome.FAIL)
          .map((check) => check.code)
          .join(', ')}.`,
      });
    }
  }

  return checkFrom({
    id,
    title,
    problems,
    pass: `Derived from revision ${derived.revisionId} of run ${derived.runId}, carried verbatim, verified on its own and of the same measurement.`,
  });
};

/** A redacted derivative passes only what it still carries (spec §9). */
const checkRedactions = (manifest: BundleManifest): Check => {
  const redactions = manifest.redactions ?? [];

  if (redactions.length === 0) {
    return decidedCheck({
      id: 'bundle.redactions',
      title: 'Redactions',
      outcome: CheckOutcome.NOT_APPLICABLE,
      code: 'full_bundle',
      explanation: 'The bundle withholds nothing.',
    });
  }

  return decidedCheck({
    id: 'bundle.redactions',
    title: 'Redactions',
    outcome: CheckOutcome.NOT_CHECKABLE,
    code: 'redacted',
    explanation: `${redactions.length} files are withheld: ${redactions
      .slice(0, 5)
      .map((entry) => `${entry.path} (${entry.reason})`)
      .join(
        '; ',
      )}${redactions.length > 5 ? '; …' : ''}. Derived from revision ${manifest.revision.predecessor?.id ?? 'unknown'}, which is not carried.`,
  });
};

/** verifyBundle checks an in-memory bundle; it performs no I/O. */
export const verifyBundle = (
  files: ReadonlyMap<string, Buffer>,
  source: string,
): Verification => {
  const reading = readManifest(files);

  if ('refusal' in reading) {
    return refusedVerification(source, reading.refusal);
  }

  const { manifest } = reading;
  const withheld = new Set(
    (manifest.redactions ?? []).map((entry) => entry.path),
  );
  const isWithheld = (file: string) => withheld.has(file);
  const read = createDocumentReader(files, isWithheld);
  const trace = checkTraceChain(files, manifest, isWithheld);
  const plan = checkPlan(manifest, read);
  const judgments = plan.inputs ? checkJudgments(plan.inputs, read) : undefined;

  let metrics: Check;

  if (!plan.inputs) {
    metrics = notRecomputed(
      'inputs_unavailable',
      'The frozen inputs could not be read, so nothing was recomputed.',
    );
  } else if (!judgments?.judgments) {
    metrics = notRecomputed(
      'judgments_unavailable',
      'The judgments the metrics come from could not be read.',
    );
  } else {
    metrics = checkMetrics({
      manifest,
      inputs: plan.inputs,
      judgments: judgments.judgments,
      read,
    });
  }

  const checks = [
    checkIntegrity(files, manifest),
    trace.check,
    checkTraceCoverage(
      manifest,
      trace.events,
      plan.inputs?.captured.map(capturedAnswerOf),
    ),
    plan.check,
    ...(judgments ? [judgments.check] : []),
    metrics,
    checkGrounding(manifest, read),
    checkCopy(files, read),
    checkLineage(files, manifest),
    checkRedactions(manifest),
  ];
  const captured = plan.inputs?.captured;
  const limitations = [
    ...manifest.trace.limitations,
    ...(plan.unknownSlots > 0
      ? [
          `${plan.unknownSlots} planned slots were neither captured nor recorded as failed.`,
        ]
      : []),
  ];

  const verification: Verification = {
    verificationVersion: 1,
    source,
    bundle: {
      runId: manifest.run.id,
      revisionId: manifest.revision.id,
      measurementId: manifest.run.measurementId,
      origin: manifest.run.origin,
      captureAuthenticity: manifest.run.captureAuthenticity,
      execution: manifest.run.execution,
      needsImprovement: manifest.run.needsImprovement,
      bundleDigest: manifest.bundleDigest,
    },
    checks,
    disclosures: {
      capturedAnswers: captured?.length ?? null,
      capturesWithoutReportedModel: captured
        ? captured.filter((record) => !record.captureMetadata?.reportedModel)
            .length
        : null,
      unjudgedAnswers: judgments?.unjudged ?? null,
      recordedCorrections: judgments?.corrections ?? null,
      acceptedFindings: manifest.acceptedFindings.length,
      traceCoverage: manifest.trace.coverage,
      limitations,
    },
    exitCode: exitCodeOf(checks),
  };

  return verification;
};
