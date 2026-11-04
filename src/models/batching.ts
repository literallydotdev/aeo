import type { z } from 'zod';
import type { InternalModelRoleConfig } from './profiles';
import { structuredCallReservation } from './structured';

/**
 * batchModelInputs bounds complete requests, including escaped data and
 * schema, before dispatch.
 */
export const batchModelInputs = <T>(args: {
  items: readonly T[];
  role: InternalModelRoleConfig;
  schema: z.ZodType;
  system: string;
  prompt: (items: T[], start: number) => string;
  maxItems?: number;
}): Array<{ items: T[]; start: number }> => {
  const batches: Array<{ items: T[]; start: number }> = [];
  // A pinned role may want a narrower batch than the call site's own default.
  const maxItems = Math.min(
    args.maxItems ?? Infinity,
    args.role.maxItemsPerCall ?? Infinity,
  );
  let items: T[] = [];
  let start = 0;

  const fits = (next: T[], offset: number) => {
    try {
      structuredCallReservation({
        role: args.role,
        schema: args.schema,
        system: args.system,
        prompt: args.prompt(next, offset),
      });

      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'model_input_limit') {
        return false;
      }

      throw error;
    }
  };

  for (const item of args.items) {
    const next = [...items, item];

    if (items.length > 0 && (next.length > maxItems || !fits(next, start))) {
      batches.push({ items, start });
      start += items.length;
      items = [];
    }

    items.push(item);

    if (!fits(items, start)) {
      throw new Error(
        'model_input_limit: a single item exceeds the selected role context',
      );
    }
  }

  if (items.length > 0) {
    batches.push({ items, start });
  }

  return batches;
};
