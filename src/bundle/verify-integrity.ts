import {
  CheckOutcome,
  checkFrom,
  decidedCheck,
  type Check,
  type Problem,
} from './checks';
import {
  bundlePaths,
  digestManifest,
  objectPathPrefix,
  type BundleEvent,
  type BundleManifest,
} from './contracts';
import { readJournal } from './journal';
import { sha256Hex } from './json';
import { assessTraceCoverage, type CapturedAnswer } from './trace-coverage';
import { bundlePathError } from './paths';

// ============================================================================
// Checks 1 and 6 of specs/aeo-open-source-cli-spec.md §10: the bundle's own
// integrity (manifest digest, inventory, objects) and its execution trace
// (chain continuity, head, references, coverage).
// ============================================================================

const inventoryProblems = (
  files: ReadonlyMap<string, Buffer>,
  manifest: BundleManifest,
): Problem[] => {
  const problems: Problem[] = [];
  const inventoried = new Set<string>();

  for (const entry of manifest.files) {
    const pathError = bundlePathError(entry.path);

    if (pathError) {
      problems.push({
        code: 'inventory_path_invalid',
        message: `Inventory path ${entry.path} is refused: ${pathError}.`,
      });
      continue;
    }

    if (inventoried.has(entry.path) || entry.path === bundlePaths.manifest) {
      problems.push({
        code: 'inventory_duplicate',
        message: `${entry.path} is listed twice or names the manifest.`,
        artifact: entry.path,
      });
      continue;
    }

    inventoried.add(entry.path);

    const bytes = files.get(entry.path);

    if (bytes === undefined) {
      problems.push({
        code: 'file_missing',
        message: `${entry.path} is in the inventory but not in the bundle.`,
        artifact: entry.path,
      });
    } else if (
      bytes.length !== entry.bytes ||
      sha256Hex(bytes) !== entry.sha256
    ) {
      problems.push({
        code: 'file_digest_mismatch',
        message: `${entry.path} does not match its inventory digest.`,
        artifact: entry.path,
      });
    }
  }

  for (const [file, bytes] of files) {
    if (file !== bundlePaths.manifest && !inventoried.has(file)) {
      problems.push({
        code: 'file_uninventoried',
        message: `${file} is in the bundle but not in the inventory.`,
        artifact: file,
      });
    }

    if (
      file.startsWith(objectPathPrefix) &&
      sha256Hex(bytes) !== file.slice(objectPathPrefix.length)
    ) {
      problems.push({
        code: 'object_digest_mismatch',
        message: `${file} does not hold the bytes its name digests.`,
        artifact: file,
      });
    }
  }

  return problems;
};

export const checkIntegrity = (
  files: ReadonlyMap<string, Buffer>,
  manifest: BundleManifest,
): Check => {
  const { bundleDigest, ...unsigned } = manifest;
  const digestProblems: Problem[] =
    digestManifest(unsigned) === bundleDigest
      ? []
      : [
          {
            code: 'bundle_digest_mismatch',
            message: 'The manifest does not match its bundle digest.',
            artifact: bundlePaths.manifest,
          },
        ];

  // A withheld file present in the bundle is no redaction at all.
  const leaked: Problem[] = (manifest.redactions ?? [])
    .filter((entry) => files.has(entry.path))
    .map((entry) => ({
      code: 'withheld_file_present',
      message: `${entry.path} is declared withheld but is in the bundle.`,
      artifact: entry.path,
    }));

  const check = checkFrom({
    id: 'bundle.integrity',
    title: 'Bundle integrity',
    problems: [
      ...digestProblems,
      ...inventoryProblems(files, manifest),
      ...leaked,
    ],
    pass: `The manifest digest and all ${manifest.files.length} inventoried files match; nothing is uninventoried.`,
  });

  return check;
};

export const checkTraceChain = (
  files: ReadonlyMap<string, Buffer>,
  manifest: BundleManifest,
  isWithheld: (file: string) => boolean = () => false,
): { check: Check; events: BundleEvent[] } => {
  const id = 'trace.chain';
  const title = 'Event chain';
  const bytes = files.get(bundlePaths.events);

  if (bytes === undefined && isWithheld(bundlePaths.events)) {
    const withheld = checkFrom({
      id,
      title,
      problems: [
        {
          code: 'document_withheld',
          message: `${bundlePaths.events} is withheld by the bundle's redaction.`,
        },
      ],
      pass: '',
    });

    return { check: withheld, events: [] };
  }

  if (bytes === undefined) {
    const missing = checkFrom({
      id,
      title,
      problems: [
        {
          code: 'document_missing',
          message: `${bundlePaths.events} is missing.`,
          artifact: bundlePaths.events,
        },
      ],
      pass: '',
    });

    return { check: missing, events: [] };
  }

  const reading = readJournal(bytes.toString('utf8'));
  const problems: Problem[] = reading.errors.map((error) => ({
    code: 'trace_chain_broken',
    message: error,
    artifact: bundlePaths.events,
  }));

  if (reading.tornTail !== undefined) {
    problems.push({
      code: 'trace_torn',
      message:
        'The journal ends in a partial line; a finalized bundle never does.',
      artifact: bundlePaths.events,
    });
  }

  const head = reading.events.at(-1)?.digest ?? null;

  if (
    reading.events.length !== manifest.events.count ||
    head !== manifest.events.head
  ) {
    problems.push({
      code: 'trace_head_mismatch',
      message: `The journal holds ${reading.events.length} events ending at ${String(head)}; the manifest records ${manifest.events.count} ending at ${String(manifest.events.head)}.`,
      artifact: bundlePaths.events,
    });
  }

  for (const event of reading.events) {
    for (const object of event.objects) {
      if (isWithheld(`${objectPathPrefix}${object}`)) {
        problems.push({
          code: 'object_withheld',
          message: `Event ${event.seq} references object ${object}, which the redaction withholds.`,
        });
      } else if (!files.has(`${objectPathPrefix}${object}`)) {
        problems.push({
          code: 'object_missing',
          message: `Event ${event.seq} references object ${object}, which the bundle does not hold.`,
          artifact: bundlePaths.events,
        });
      }
    }
  }

  const check = checkFrom({
    id,
    title,
    problems,
    pass: `${reading.events.length} events chain to the manifest head; every referenced object is present.`,
  });

  return { check, events: reading.events };
};

export const checkTraceCoverage = (
  manifest: BundleManifest,
  events: readonly BundleEvent[],
  /** The bundle's captured answers; undefined when they cannot be read. */
  captured: readonly CapturedAnswer[] | undefined,
): Check => {
  const id = 'trace.coverage';
  const title = 'Trace coverage';
  const finished = new Set(
    events
      .filter((event) => event.type === 'operation_finished')
      .map((event) => event.operationId),
  );
  const started = events.filter((event) => event.type === 'operation_started');
  const unresolved = started.filter(
    (event) => !finished.has(event.operationId),
  ).length;
  const recorded =
    unresolved > 0
      ? `${started.length} operations recorded, ${unresolved} without an outcome at the exported cutoff; their result is unknown.`
      : `${started.length} operations recorded, each with an outcome.`;

  if (manifest.trace.coverage === 'none') {
    return decidedCheck({
      id,
      title,
      outcome: CheckOutcome.NOT_CHECKABLE,
      code: 'trace_absent',
      explanation: manifest.trace.limitations.join(' '),
    });
  }

  if (manifest.trace.coverage === 'partial') {
    return decidedCheck({
      id,
      title,
      outcome: CheckOutcome.NOT_CHECKABLE,
      code: 'trace_partial',
      explanation: [recorded, ...manifest.trace.limitations].join(' '),
    });
  }

  if (unresolved > 0) {
    return decidedCheck({
      id,
      title,
      outcome: CheckOutcome.NOT_CHECKABLE,
      code: 'operations_unresolved',
      explanation: recorded,
    });
  }

  // The claim is re-derived from the events, never taken from the manifest.
  if (captured === undefined) {
    return decidedCheck({
      id,
      title,
      outcome: CheckOutcome.NOT_CHECKABLE,
      code: 'captures_unavailable',
      explanation: `${recorded} The captured answers could not be read, so whether a probe operation returned each one was not checked.`,
    });
  }

  const assessment = assessTraceCoverage({
    events,
    captured,
    derived: manifest.run.derivedFrom !== undefined,
  });

  if (assessment.gaps.length > 0) {
    return decidedCheck({
      id,
      title,
      outcome: CheckOutcome.FAIL,
      code: 'trace_coverage_overstated',
      explanation: `The manifest declares full coverage, but: ${assessment.gaps.join(' ')}`,
    });
  }

  return decidedCheck({
    id,
    title,
    outcome: CheckOutcome.PASS,
    code: 'ok',
    explanation: `${recorded} Every writer observed every operation kind, and a probe operation returned each captured answer byte for byte. Coverage means the operations the adapters declare observable, not all activity on the machine.`,
  });
};
