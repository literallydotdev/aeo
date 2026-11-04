import type { AeoSurface } from './surfaces';

// The same fields as ProgressSlot, spelled out so this module stays free of
// progress-schema and zod: both the schema and the client-side comparison
// import it.
type ProgressSlotIdentity = {
  sectionKey: string;
  questionKey: string;
  surface: AeoSurface;
  runIndex: number;
};

export const progressSlotKey = (slot: ProgressSlotIdentity): string => {
  return JSON.stringify([
    slot.sectionKey,
    slot.questionKey,
    slot.surface,
    slot.runIndex,
  ]);
};
