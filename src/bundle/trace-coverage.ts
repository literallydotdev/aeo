import { operationKindsOf, type BundleEvent } from './contracts';
import { sha256Hex } from './json';

// ============================================================================
// Whether a run journal covers every declared observable operation
// (specs/aeo-open-source-cli-spec.md §7.2). One rule, used by the export to
// decide the coverage it claims and by the verifier to re-derive it from the
// events instead of trusting the manifest.
// ============================================================================

/** The identity and answer of one captured unit, as the bundle holds it. */
export type CapturedAnswer = {
  sectionKey: string;
  surface: string;
  promptId: string;
  runIndex: number;
  text: string;
};

export type TraceCoverageAssessment = {
  /** What stops the journal from covering every declared operation. */
  gaps: string[];
  /** What is covered elsewhere, stated so the reader knows where. */
  notes: string[];
};

const unitKey = (unit: Omit<CapturedAnswer, 'text'>): string => {
  return JSON.stringify([
    unit.sectionKey,
    unit.surface,
    unit.promptId,
    unit.runIndex,
  ]);
};

const stringList = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
};

const recordOf = (value: unknown): Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
};

/** The kinds some writer of the run did not declare it observes. */
const unobservedKinds = (
  events: readonly BundleEvent[],
  bundleSchema: number,
): string[] => {
  const kinds = operationKindsOf(bundleSchema);
  const writers = events.filter(
    (event) => event.type === 'run_started' || event.type === 'run_resumed',
  );

  if (writers.length === 0) {
    return [...kinds];
  }

  return kinds.filter((kind) =>
    writers.some(
      (writer) => !stringList(writer.payload.observes).includes(kind),
    ),
  );
};

/** Unit key to the digests of every answer a succeeded probe returned. */
const probedAnswers = (
  events: readonly BundleEvent[],
): Map<string, Set<string>> => {
  const probes = new Map<string, string>();
  const answers = new Map<string, Set<string>>();

  for (const event of events) {
    if (event.operationId === null) {
      continue;
    }

    if (event.type === 'operation_started' && event.payload.kind === 'probe') {
      const details = recordOf(event.payload.details);

      probes.set(
        event.operationId,
        unitKey({
          sectionKey: String(details.sectionKey),
          surface: String(details.surface),
          promptId: String(details.promptId),
          runIndex: Number(details.runIndex),
        }),
      );
    }

    const key = probes.get(event.operationId);
    const answer = recordOf(event.payload.outputs).answer;

    if (
      event.type === 'operation_finished' &&
      key !== undefined &&
      event.payload.outcome === 'succeeded' &&
      typeof answer === 'string'
    ) {
      answers.set(key, (answers.get(key) ?? new Set()).add(answer));
    }
  }

  return answers;
};

/**
 * assessTraceCoverage finds the gaps in a journal: a writer that did not
 * observe every operation kind, or a captured answer that no probe
 * operation in the journal returned byte for byte. A derived run's answers
 * come from its predecessor, whose own trace covers them. The kinds are
 * those of the bundle's own schema version.
 */
export const assessTraceCoverage = ({
  events,
  captured,
  derived,
  bundleSchema,
}: {
  events: readonly BundleEvent[];
  captured: readonly CapturedAnswer[];
  derived: boolean;
  bundleSchema: number;
}): TraceCoverageAssessment => {
  const gaps: string[] = [];
  const notes: string[] = [];
  const unobserved = unobservedKinds(events, bundleSchema);

  if (unobserved.length > 0) {
    gaps.push(
      `A writer of this run did not record ${unobserved.join(', ')} operations.`,
    );
  }

  const answers = probedAnswers(events);
  const unprobed = captured.filter(
    (unit) =>
      !answers
        .get(unitKey(unit))
        ?.has(sha256Hex(Buffer.from(unit.text, 'utf8'))),
  ).length;

  if (unprobed > 0 && derived) {
    notes.push(
      `${unprobed} of ${captured.length} captured answers come from the predecessor revision; its own trace, in predecessors/, records how they were captured.`,
    );
  } else if (unprobed > 0) {
    gaps.push(
      `${unprobed} of ${captured.length} captured answers have no probe operation in this journal that returned them: they were banked before it began, and their answers are in captures/.`,
    );
  }

  return { gaps, notes };
};

/** capturedAnswerOf reads a banked capture record as a captured answer. */
export const capturedAnswerOf = (record: {
  sectionKey: string;
  surface: string;
  promptId: string;
  runIndex: number;
  probe: { text: string };
}): CapturedAnswer => {
  return {
    sectionKey: record.sectionKey,
    surface: record.surface,
    promptId: record.promptId,
    runIndex: record.runIndex,
    text: record.probe.text,
  };
};
