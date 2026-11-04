import type { AeoSurface } from '../schema';
import type { ProbeFailureKind } from './failure';

// ============================================================================
// Probe outcomes (hardening spec §4.1): every planned unit a runner is asked
// to execute ends in exactly one outcome, captured or failed, never a
// filtered list. The pipeline persists both kinds, so a resumed run can
// tell "never attempted" from "failed three times an hour ago".
// ============================================================================

export type ProbeUnitRef = {
  promptId: string;
  surface: AeoSurface;
  runIndex: number;
};

export type ProbeOutcome<P> =
  | { status: 'captured'; unit: ProbeUnitRef; probe: P; attempts: number }
  | {
      status: 'failed';
      unit: ProbeUnitRef;
      kind: ProbeFailureKind;
      attempts: number;
      // Never contains the prompt text.
      lastError: string;
    };

export const capturedOutcomes = <P>(
  outcomes: readonly ProbeOutcome<P>[],
): P[] => {
  const probes: P[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === 'captured') {
      probes.push(outcome.probe);
    }
  }

  return probes;
};
