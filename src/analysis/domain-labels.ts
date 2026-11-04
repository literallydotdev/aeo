import { z } from 'zod';
import { sourceCategories, type SourceCategory } from '../schema';

// ============================================================================
// The committed domain-labels file (spec §7.1 amendment, 2026-09-04): the
// learned source labels behind a report's citation mix, written next to its
// snapshot. Runner-free on purpose — the report page reads this file at
// build time so its opened-pages list labels hosts exactly like the source
// mix, and must not drag the AI SDK in to do so. The pass that produces the
// labels lives in domain-classifier.ts.
// ============================================================================

export const domainLabelsFile = 'domain-labels.json';

// Bump whenever the model prompt, categories, or model change: every cached
// model label is then re-derived on the next run (analyzer labels are
// recomputed every run anyway). Recorded in snapshot meta as
// domainClassifierVersion.
//   1 — first version.
//   2 — only qualified entities become competitors; labels respect section scope.
// v3 (2026-09-13): every host under a configured competitor's registrable
// domain is a competitor source by config.
// v4 (2026-09-13): re-derive after a run committed labels whose batches
// were abandoned for budget.
export const domainClassifierVersion = 4;

export const domainLabelsFileSchema = z.object({
  version: z.number().int(),
  model: z.string(),
  // Hash of the market context the model labels were judged in (brand,
  // brief, prompt texts — hardening spec §2.7). Optional: files written
  // before it existed carry none. A mismatch on reuse is logged, not fatal:
  // the labels are still the best available and a bump of
  // domainClassifierVersion is the deliberate way to re-judge them.
  contextHash: z.string().optional(),
  modelProfileDigest: z.string().optional(),
  // host (www. stripped) → label + where it came from. Sorted on write so
  // the committed diff reads as "which hosts changed".
  entries: z.record(
    z.string(),
    z.object({
      category: z.enum(sourceCategories),
      // config: the domain of a configured competitor, settled by the
      // report's own competitor list; analyzer: a qualified competitor's
      // domain; model: judged by the domain classifier.
      source: z.enum(['analyzer', 'model', 'config']),
    }),
  ),
});

export type DomainLabelsFile = z.infer<typeof domainLabelsFileSchema>;

/**
 * learnedLabels returns the flat host → category map the source classifier
 * consumes as `learned`.
 */
export const learnedLabels = (
  file: DomainLabelsFile,
): Record<string, SourceCategory> => {
  const labels: Record<string, SourceCategory> = {};

  for (const [host, entry] of Object.entries(file.entries)) {
    labels[host] = entry.category;
  }

  return labels;
};
