import { modelBoundSurfaces, type ModelBoundSurface } from '../probes/bindings';
import type { AeoSurface, AeoVisibility } from '../schema';
import { isCustomSurface, surfaceLabels as builtInLabels } from '../surfaces';

// ============================================================================
// The methodology section of a report (method release spec §8): a fixed set
// of sentences, built by the host from what the run measured and stored in
// the snapshot, so the copy cannot embellish it. Every sentence states what
// was done or what a number means; none describes a result.
// ============================================================================

export type MethodologyInput = {
  /** The surfaces the run planned. */
  surfaces: readonly AeoSurface[];
  /** The model each API chat surface's captured answers were asked of. */
  askedModels: Readonly<Partial<Record<ModelBoundSurface, readonly string[]>>>;
  /** The engine's default model per API chat surface, and when the
   * defaults were chosen. */
  defaults: {
    models: Readonly<Record<ModelBoundSurface, string | undefined>>;
    chosenOn: string;
  };
  /** The snapshot's own labels (custom surfaces, swapped models). */
  labels: Readonly<Record<string, string>>;
  sections: readonly { visibility: AeoVisibility }[];
};

const labelOf = (
  surface: AeoSurface,
  labels: Readonly<Record<string, string>>,
): string => {
  return labels[surface] ?? builtInLabels[surface] ?? surface;
};

const hasIntervals = (sections: MethodologyInput['sections']): boolean => {
  return sections.some(({ visibility }) =>
    Object.values(visibility.summary.byModel).some(
      (rates) => rates.shareOfVoiceEvidence !== undefined,
    ),
  );
};

/** buildMethodology states how the run measured, in the order a reader
 * needs it: what was asked, what was not, and what the numbers mean. */
export const buildMethodology = ({
  surfaces,
  askedModels,
  defaults,
  labels,
  sections,
}: MethodologyInput): string[] => {
  const sentences: string[] = [];
  const apiSurfaces = modelBoundSurfaces.filter((surface) =>
    surfaces.includes(surface),
  );

  if (apiSurfaces.length > 0) {
    const asked = apiSurfaces.map((surface) => {
      const models = askedModels[surface] ?? [];
      const name = builtInLabels[surface] ?? surface;

      return models.length === 0
        ? `${name}: no answer captured`
        : `${name}: ${models.join(', ')}`;
    });
    const swapped = apiSurfaces.filter((surface) =>
      (askedModels[surface] ?? []).some(
        (model) => model !== defaults.models[surface],
      ),
    );

    sentences.push(
      `The API chat surfaces ask each provider's model through its API with web search, not through its consumer app. Models asked: ${asked.join('; ')}.`,
      swapped.length === 0
        ? `Each is the gateway model closest to what the consumer product served its free tier by default when the models were chosen, on ${defaults.chosenOn}. It is the nearest match, not the same product. Where a vendor names no model or no version for its free tier, it is the nearest model the gateway lists.`
        : `A surface on its default asks the gateway model closest to what the consumer product served its free tier by default when the defaults were chosen, on ${defaults.chosenOn}; it is the nearest match, not the same product. Where a vendor names no model or no version for its free tier, it is the nearest model the gateway lists. Asked of another model than that default: ${swapped.map((surface) => builtInLabels[surface] ?? surface).join(', ')}.`,
      'Paid tiers of these products, and their thinking or reasoning modes, are not measured.',
    );
  }

  const custom = surfaces.filter(isCustomSurface);

  if (custom.length > 0) {
    sentences.push(
      `Custom models (${custom.map((surface) => labelOf(surface, labels)).join('; ')}) were chosen by this audit's author. Each is asked every question through the gateway's own web search tool, which is not the search its maker's product uses. The tool attaches no source list to an answer, so a custom model's citation rate counts only the links the model writes in its answer. They are scored on their own lines and are not part of the headline rates.`,
    );
  }

  sentences.push(
    'A rate is a share of the planned answers: an answer that was planned and not captured counts as one in which the company was not mentioned or cited.',
  );

  if (hasIntervals(sections)) {
    sentences.push(
      'Beside each rate, the approximate 95% interval (a Wilson score interval) describes answer-to-answer variation for these questions at the time of the audit. It is not a market share, not uncertainty about which questions buyers ask, and not a forecast. Where answers were not captured, the interval allows for either outcome in each of them.',
      'The interval assumes that repeated runs of one question are independent. Runs minutes apart can share a search index or a provider cache; if they return near-duplicate answers, the interval is too narrow.',
    );
  }

  if (apiSurfaces.length > 0) {
    sentences.push(
      "Figures from literally-aeo 0.4.0 or later are comparable with an earlier release's only as a disclosed change of collection method: the models the API chat surfaces ask changed with that release.",
    );
  }

  return sentences;
};
