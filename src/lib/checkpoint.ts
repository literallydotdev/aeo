import { createHash } from 'node:crypto';
import type { AeoPrompt, AeoSurface, ProbeDepth } from '../schema';
import { agentProbedPrompts, isAgentSurface, runsPerPromptOn } from '../schema';
import type { CheckpointMatch, ProbeUnit } from '../stores/ports';

export type {
  CapturedUnitRecord,
  CheckpointMatch,
  CheckpointProbe,
  FailedUnitRecord,
  ProbeUnit,
  UnitRecord,
} from '../stores/ports';

// ============================================================================
// Probe planning and unit keys. The planned-units list is the resume scope
// (what the probe store is matched against), the cost estimate, and the
// scoring denominator — one source so they can never disagree. The stores
// themselves live in src/stores/ (hardening spec §4.4).
// ============================================================================

// Key parts join on `|`, never a control character: the key is a Postgres
// text column (NUL bytes are rejected there) and a human reads it in the
// row. Section keys and prompt ids are identifiers and never contain it.
const keySeparator = '|';

/** Key without the prompt text: section | surface | prompt id | run index. */
export const probeUnitKey = (unit: {
  sectionKey: string;
  surface: AeoSurface;
  promptId: string;
  runIndex: number;
}): string => {
  return [unit.sectionKey, unit.surface, unit.promptId, unit.runIndex].join(
    keySeparator,
  );
};

export const promptTextHash = (promptText: string): string => {
  return createHash('sha256').update(promptText).digest('hex');
};

/**
 * Storage key of a unit record (§4.2): the unit key plus a hash of the
 * prompt text, so an edited prompt is a miss by construction and a
 * redelivered capture of the same unit collides.
 */
export const unitRecordKey = (unit: ProbeUnit): string => {
  return `${probeUnitKey(unit)}${keySeparator}${promptTextHash(unit.promptText)}`;
};

/**
 * The probe units a run plans for one section: chat surfaces cover every
 * prompt, agent surfaces the config's agentProbes subset, each at the depth
 * runsPerPromptOn gives it. Mirrors the pipeline's fan-out exactly — the
 * planned set is both the resume scope and the scoring denominator.
 */
export const plannedProbeUnitsForSection = (
  args: ProbeDepth & {
    sectionKey: string;
    prompts: AeoPrompt[];
    surfaces: readonly AeoSurface[];
  },
): ProbeUnit[] => {
  const chatSurfaces = args.surfaces.filter((s) => !isAgentSurface(s));
  const agentSurfaces = args.surfaces.filter(isAgentSurface);
  const agentPrompts = agentProbedPrompts(args.prompts, args.agentProbes);

  const units: ProbeUnit[] = [];

  for (const prompt of args.prompts) {
    for (const surface of chatSurfaces) {
      for (let run = 1; run <= runsPerPromptOn(surface, args); run += 1) {
        units.push(
          createUnit({
            sectionKey: args.sectionKey,
            prompt,
            surface,
            runIndex: run,
          }),
        );
      }
    }
  }

  for (const prompt of agentPrompts) {
    for (const surface of agentSurfaces) {
      for (let run = 1; run <= runsPerPromptOn(surface, args); run += 1) {
        units.push(
          createUnit({
            sectionKey: args.sectionKey,
            prompt,
            surface,
            runIndex: run,
          }),
        );
      }
    }
  }

  return units;
};

export const entryMatches = (
  entry: { sectionKey: string; surface: AeoSurface },
  match: CheckpointMatch,
): boolean => {
  if (match.sectionKey && entry.sectionKey !== match.sectionKey) {
    return false;
  }

  if (match.surface && entry.surface !== match.surface) {
    return false;
  }

  return true;
};

type CreateUnitPayload = {
  sectionKey: string;
  prompt: AeoPrompt;
  surface: AeoSurface;
  runIndex: number;
};

const createUnit = ({
  sectionKey,
  prompt,
  surface,
  runIndex,
}: CreateUnitPayload): ProbeUnit => {
  return {
    sectionKey,
    promptId: prompt.id,
    promptText: prompt.text,
    surface,
    runIndex,
  };
};
