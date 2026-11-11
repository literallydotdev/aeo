import { createGateway } from '@ai-sdk/gateway';
import { toolVersion } from '../bundle/contracts';
import type { CapturedUnitRecord } from '../stores/ports';
import type { CatalogModel } from '../models/catalog';
import {
  gatewaySearchProbeUsage,
  gatewaySearchUsd,
  probeSearchUsd,
  probeUsage,
  type Range,
} from '../models/cost-coefficients';
import {
  allSurfaces,
  surfaceLabels,
  customSurfacePrefix,
  isBuiltInSurface,
  isConsumerSurface,
  isCustomSurface,
  type AeoApiSurface,
  type AeoBuiltInSurface,
  type AeoChatSurface,
  type AeoConsumerSurface,
  type AeoCustomSurface,
  type AeoDefaultSurface,
  type AeoSurface,
} from '../surfaces';
import {
  ProbeAdapterId,
  type ChatModelProvider,
  type ProbeAdapter,
  type ProbeAdapterProfile,
} from './adapter';
import { cliAdapterProfiles } from './adapters/cli-agents';
import {
  createDataForSeoAiModeAdapter,
  dataForSeoAiModeProfile,
} from './adapters/dataforseo-ai-mode';
import {
  createDataForSeoAiOverviewAdapter,
  dataForSeoAiOverviewProfile,
} from './adapters/dataforseo-ai-overview';
import {
  createDataForSeoChatGptAppAdapter,
  dataForSeoChatGptAppProfile,
} from './adapters/dataforseo-chatgpt-app';
import {
  createGatewayChatAdapter,
  gatewayChatProfiles,
} from './adapters/gateway-chat';
import {
  createGatewayPerplexityAdapter,
  gatewayPerplexityProfile,
} from './adapters/gateway-perplexity';
import {
  createDataForSeoProbeClient,
  type DataForSeoLocale,
  type DataForSeoProbeClient,
} from './dataforseo';
import { resolveDataForSeoLocale } from './dataforseo-locale';
import { legacyProbeBindings, type ProbeBinding } from './legacy-bindings';

// ============================================================================
// Bindings (specs/aeo-probe-adapters-spec.md §4.5): which adapter, with which
// parameters, measures each surface. Until a method release changes them,
// the defaults are the legacy bindings, and they are the only bindings a run
// can have. A run freezes its bindings before its first probe and keeps
// them on every resume (engine/run-bindings.ts); a resume never changes
// vendor or model silently.
// ============================================================================

export type { ProbeBinding };

/** A run's frozen bindings: one per default surface, and one per consumer
 * app the audit lists and per custom surface it declares. */
export type RunBindings = Readonly<Record<AeoDefaultSurface, ProbeBinding>> &
  Readonly<Partial<Record<AeoConsumerSurface, ProbeBinding>>> & {
    readonly [custom: AeoCustomSurface]: ProbeBinding;
  };

/** The binding a run froze for `surface`. A custom surface the bindings do
 * not hold was never declared, and a consumer app they do not hold is one
 * the run directory started without: the plan would contain neither. */
export const bindingOf = (
  bindings: RunBindings,
  surface: AeoSurface,
): ProbeBinding => {
  const binding = bindings[surface];

  if (!binding) {
    throw new RunBindingsError(
      isCustomSurface(surface)
        ? `This run's bindings name no adapter for ${surface}. A custom surface is measured only when audit.json declares it in customSurfaces.`
        : `This run's bindings name no adapter for ${surface}: the run directory started without it. A run never changes what it measures: measure ${surface} in a new run directory.`,
    );
  }

  return binding;
};

const legacyBindings: Readonly<Partial<Record<AeoSurface, ProbeBinding>>> =
  legacyProbeBindings;

/** A surface's binding as of 0.2.0; a consumer or custom surface has
 * none. */
export const legacyBindingOf = (
  surface: AeoSurface,
): ProbeBinding | undefined => {
  return legacyBindings[surface];
};

/**
 * Thrown before any dispatch when a run's frozen bindings cannot be
 * honoured: a binding the installed engine cannot build, or a banked answer
 * taken with another adapter. The run stops resumable (exit 2); nothing is
 * probed under a binding the run did not freeze.
 */
export class RunBindingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunBindingsError';
  }
}

/**
 * What a run hands its adapters (probe adapters spec §3.1): everything an
 * adapter needs is passed in when it is created, never read from the
 * environment or a module global.
 */
export type ProbeDependencies = {
  /** The run's frozen bindings: which adapter measures each surface. */
  bindings: RunBindings;
  /** The run's gateway provider, created with its own key. */
  gateway: ChatModelProvider;
  /** The run's DataForSEO client; absent when the run has no credentials,
   * which fails each AI Overview probe as an auth failure. */
  dataForSeo?: DataForSeoProbeClient;
  /** Adapters beyond the engine's own: consulted first for a chat surface,
   * with the binding the run froze for it. A host or a test registers one
   * here; nothing in the engine changes to add it. */
  registry?: ChatAdapterRegistry;
};

/** An adapter for `surface` under `binding`, or undefined to leave it to
 * the engine's own adapters. */
export type ChatAdapterRegistry = (
  surface: AeoApiSurface,
  binding: ProbeBinding,
) => ProbeAdapter | undefined;

/**
 * probeDependenciesOf creates a run's probe clients from its settings, for
 * the local run and for a host alike: the engine builds the gateway with its
 * own pinned provider package, which shapes every probe request. The
 * gateway key is required: without one, the provider package would look
 * for a key in the process environment on its own. The DataForSEO client is
 * absent when its credentials are not set; preflight requires them for
 * every surface in scope.
 */
export const probeDependenciesOf = (
  env: NodeJS.ProcessEnv,
  bindings: RunBindings,
): ProbeDependencies => {
  const apiKey = env.AI_GATEWAY_API_KEY;
  const login = env.DATAFORSEO_LOGIN;
  const password = env.DATAFORSEO_PASSWORD;

  if (!apiKey) {
    throw new Error(
      'AI_GATEWAY_API_KEY is not set in the settings the probe clients are created from. Please set it; every run calls the gateway.',
    );
  }

  const dependencies: ProbeDependencies = {
    bindings,
    gateway: createGateway({ apiKey }),
    ...(login && password
      ? { dataForSeo: createDataForSeoProbeClient({ login, password }) }
      : {}),
  };

  return dependencies;
};

/**
 * The bindings a new run freezes (method release spec §4): each API chat
 * surface asks the gateway model closest to what its consumer product
 * serves the free tier by default, as each vendor's own pages said on
 * 10 November 2026. Where a vendor names no model or no version, the
 * comment says so. The methodology section names each as the nearest match,
 * not the same product. The other surfaces keep their legacy binding.
 */
export const defaultBindingsChosenOn = '2026-11-10';

export const defaultProbeBindings: Readonly<
  Record<AeoDefaultSurface, ProbeBinding>
> = {
  ...legacyProbeBindings,
  // The Free plan's chat model is GPT-6 Luna (chatgpt.com/pricing). It
  // became the Free and Go default about 8 October 2026, a date read from
  // reposts of OpenAI's release notes, not from the notes themselves.
  chatgpt: {
    adapter: ProbeAdapterId.GATEWAY_OPENAI,
    model: 'openai/gpt-6-luna',
  },
  // "The default model for Free and Pro plans" since 30 June 2026
  // (anthropic.com/news/claude-sonnet-5). Anthropic has not said that
  // Sonnet 5.5 replaced it on the Free plan.
  claude: {
    adapter: ProbeAdapterId.GATEWAY_ANTHROPIC,
    model: 'anthropic/claude-sonnet-5',
  },
  // Without a plan, "Auto" sends "most prompts" to Flash-Lite, a change
  // announced for 9 October 2026 (support.google.com/gemini/answer/17004136).
  // Google names no version; 3.5 is the newest Flash-Lite the gateway lists.
  gemini: {
    adapter: ProbeAdapterId.GATEWAY_GOOGLE,
    model: 'google/gemini-3.5-flash-lite',
  },
  // The free default ("Best") names no model. Sonar is the only Perplexity
  // chat model the gateway lists, and the gateway reported it as the
  // served model for requests to sonar-pro (November 2026).
  perplexity: {
    adapter: ProbeAdapterId.GATEWAY_PERPLEXITY,
    model: 'perplexity/sonar',
  },
};

/**
 * The binding of each consumer app (method release spec §5): a scrape has
 * no model to name, so each has exactly one. A run freezes it only for an
 * app its audit lists, so a run that lists none freezes what it always
 * did, and a later version of a scrape never strands a directory that
 * measured no app.
 */
export const consumerProbeBindings: Readonly<
  Record<AeoConsumerSurface, ProbeBinding>
> = {
  chatgpt_app: { adapter: ProbeAdapterId.DATAFORSEO_CHATGPT_APP },
  google_ai_mode: { adapter: ProbeAdapterId.DATAFORSEO_AI_MODE },
};

/** The engine's own binding of a built-in surface. */
export const ownBindingOf = (surface: AeoBuiltInSurface): ProbeBinding => {
  return isConsumerSurface(surface)
    ? consumerProbeBindings[surface]
    : defaultProbeBindings[surface];
};

/** Every registered adapter's profile, by ID. */
export const probeAdapterProfiles: Readonly<
  Record<ProbeAdapterId, ProbeAdapterProfile>
> = {
  [ProbeAdapterId.GATEWAY_OPENAI]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_OPENAI],
  [ProbeAdapterId.GATEWAY_SEARCH]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_SEARCH],
  [ProbeAdapterId.GATEWAY_GOOGLE]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_GOOGLE],
  [ProbeAdapterId.GATEWAY_ANTHROPIC]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_ANTHROPIC],
  [ProbeAdapterId.GATEWAY_PERPLEXITY]: gatewayPerplexityProfile,
  [ProbeAdapterId.DATAFORSEO_AI_OVERVIEW]: dataForSeoAiOverviewProfile,
  [ProbeAdapterId.DATAFORSEO_AI_MODE]: dataForSeoAiModeProfile,
  [ProbeAdapterId.DATAFORSEO_CHATGPT_APP]: dataForSeoChatGptAppProfile,
  [ProbeAdapterId.CLI_CLAUDE_CODE]: cliAdapterProfiles.claude_code,
  [ProbeAdapterId.CLI_CODEX]: cliAdapterProfiles.codex,
  [ProbeAdapterId.CLI_CURSOR]: cliAdapterProfiles.cursor,
};

/** The profile of the adapter a binding names. */
export const profileOf = (binding: ProbeBinding): ProbeAdapterProfile => {
  return probeAdapterProfiles[binding.adapter];
};

/** The API chat surfaces: the ones a model can be swapped behind. */
export const modelBoundSurfaces = [
  'chatgpt',
  'gemini',
  'claude',
  'perplexity',
] as const satisfies readonly AeoChatSurface[];

export type ModelBoundSurface = (typeof modelBoundSurfaces)[number];

/** The adapters that ask a gateway model: the ones a model override can
 * name or infer. */
export const modelAdapterIds = [
  ProbeAdapterId.GATEWAY_OPENAI,
  ProbeAdapterId.GATEWAY_GOOGLE,
  ProbeAdapterId.GATEWAY_ANTHROPIC,
  ProbeAdapterId.GATEWAY_PERPLEXITY,
  ProbeAdapterId.GATEWAY_SEARCH,
] as const;

type ModelAdapterId = (typeof modelAdapterIds)[number];

const isModelAdapterId = (adapter: string): adapter is ModelAdapterId => {
  return modelAdapterIds.some((id) => id === adapter);
};

// Each provider's own search tool only works with that provider's models,
// so the adapter follows the model's provider (open models spec §4).
const adapterByProvider: Readonly<Record<string, ModelAdapterId>> = {
  openai: ProbeAdapterId.GATEWAY_OPENAI,
  google: ProbeAdapterId.GATEWAY_GOOGLE,
  anthropic: ProbeAdapterId.GATEWAY_ANTHROPIC,
  perplexity: ProbeAdapterId.GATEWAY_PERPLEXITY,
};

/** What audit.json's `probes` asks for one surface. */
export type ProbeOverride = { model: string; adapter?: ModelAdapterId };

export type ProbeOverrides = Partial<Record<ModelBoundSurface, ProbeOverride>>;

/** A custom surface as audit.json declares it. */
export type CustomSurfaceDeclaration = ProbeOverride & { key: string };

/** The ID of the custom surface declared under `key`. */
export const customSurfaceId = (key: string): AeoCustomSurface => {
  return `${customSurfacePrefix}${key}`;
};

/**
 * requestedBindingsOf is the bindings a new run freezes: the defaults, with
 * each override's model behind its surface, one binding per declared
 * custom surface, and the binding of each consumer app the audit lists. A
 * built-in surface's adapter is the one the override names, or its
 * provider's own search; a model of another provider, and every custom
 * surface, searches through the gateway's own tool.
 */
export const requestedBindingsOf = (
  overrides: ProbeOverrides = {},
  custom: readonly CustomSurfaceDeclaration[] = [],
  consumerApps: readonly AeoConsumerSurface[] = [],
): RunBindings => {
  const swapped = Object.fromEntries(
    modelBoundSurfaces.flatMap((surface) => {
      const override = overrides[surface];

      if (!override) {
        return [];
      }

      const provider = override.model.split('/')[0] ?? '';
      const adapter =
        override.adapter ??
        adapterByProvider[provider] ??
        ProbeAdapterId.GATEWAY_SEARCH;

      return [[surface, { adapter, model: override.model }]];
    }),
  );
  const declared: Record<AeoCustomSurface, ProbeBinding> = {};

  for (const { key, model, adapter } of custom) {
    declared[customSurfaceId(key)] = {
      adapter: adapter ?? ProbeAdapterId.GATEWAY_SEARCH,
      model,
    };
  }

  const listed = Object.fromEntries(
    consumerApps.map((surface) => [surface, consumerProbeBindings[surface]]),
  );

  return { ...defaultProbeBindings, ...swapped, ...listed, ...declared };
};

/** Whether the engine has its own cost figure for a binding: one of its
 * default or legacy bindings. Any other is priced from the catalog. */
export const isOwnBinding = (binding: ProbeBinding): boolean => {
  return allSurfaces.some((surface) =>
    [ownBindingOf(surface), legacyBindingOf(surface)].some(
      (own) => own?.adapter === binding.adapter && own.model === binding.model,
    ),
  );
};

/** The models a run's bindings need a catalog price for. */
export const catalogPricedModels = (
  bindings: RunBindings,
  surfaces: readonly AeoSurface[],
): string[] => {
  return [
    ...new Set(
      surfaces.flatMap((surface) => {
        const binding = bindingOf(bindings, surface);

        return binding.model !== undefined && !isOwnBinding(binding)
          ? [binding.model]
          : [];
      }),
    ),
  ];
};

/**
 * probeEstimateUsd is what one probe under `binding` is estimated and
 * reserved at: the engine's flat figure for its own bindings, and for any
 * other model the assumed usage of a probe at that model's catalog price.
 */
export const probeEstimateUsd = (
  binding: ProbeBinding,
  priced: ReadonlyMap<string, CatalogModel>,
): Range<number> => {
  const flat = profileOf(binding).estimateUsd;

  if (binding.model === undefined || isOwnBinding(binding)) {
    return flat;
  }

  const model = priced.get(binding.model);

  if (!model) {
    throw new Error(
      `No catalog price was resolved for ${binding.model}; a probe is never reserved without one.`,
    );
  }

  const { input, output } = model.pricingUsdPerMillion;
  // The gateway's tool has its own fee and its own usage; a provider's own
  // search is priced by the model's catalog entry.
  const viaGatewaySearch = binding.adapter === ProbeAdapterId.GATEWAY_SEARCH;
  const usage = viaGatewaySearch ? gatewaySearchProbeUsage : probeUsage;
  const search = viaGatewaySearch
    ? gatewaySearchUsd
    : (model.webSearchUsdPerRequest ?? probeSearchUsd);
  const costOf = (end: 'low' | 'high') => {
    return (
      (usage.input[end] * input + usage.output[end] * output) / 1e6 +
      usage.searches[end] * search
    );
  };

  return { low: costOf('low'), high: costOf('high') };
};

// A binding the engine can build: an adapter it has, with a model exactly
// when the adapter asks one. The model itself is not judged (open models
// spec §2): a run that names one the provider refuses stops at its canary.
const availableBinding = (
  surface: AeoSurface,
  binding: { adapter: string; model?: string },
): ProbeBinding | undefined => {
  // A custom surface is always a model behind a model adapter.
  if (isCustomSurface(surface)) {
    return isModelAdapterId(binding.adapter) && binding.model !== undefined
      ? { adapter: binding.adapter, model: binding.model }
      : undefined;
  }

  const own = ownBindingOf(surface);

  if (isModelAdapterId(binding.adapter)) {
    return binding.model !== undefined && isModelAdapterId(own.adapter)
      ? { adapter: binding.adapter, model: binding.model }
      : undefined;
  }

  return binding.adapter === own.adapter && binding.model === undefined
    ? own
    : undefined;
};

/**
 * availableBindings returns a run's frozen bindings once the installed
 * engine can build every one of them, and otherwise names the binding the
 * run needs.
 */
export const availableBindings = (
  frozen: Readonly<Record<string, { adapter: string; model?: string }>>,
): RunBindings => {
  const unknown = Object.keys(frozen).filter(
    (surface) => !isBuiltInSurface(surface) && !isCustomSurface(surface),
  );

  if (unknown.length > 0) {
    throw new RunBindingsError(
      `This run directory binds surfaces literally-aeo ${toolVersion} does not measure: ${unknown.join(', ')}. Please resume it with the release that started it.`,
    );
  }

  const available = (surface: AeoSurface): ProbeBinding => {
    const binding = frozen[surface];

    if (!binding) {
      throw new RunBindingsError(
        `This run directory's frozen bindings name no adapter for ${surface}. Please resume it with the release that started it.`,
      );
    }

    const built = availableBinding(surface, binding);

    if (!built) {
      const named =
        binding.model === undefined
          ? binding.adapter
          : `${binding.adapter} with ${binding.model}`;

      throw new RunBindingsError(
        `This run directory measures ${surface} with ${named}, which literally-aeo ${toolVersion} cannot run. Please resume it with a release that has that binding; a run never changes how a surface is measured.`,
      );
    }

    return built;
  };
  // Frozen only by a run whose audit lists or declares them.
  const optional: Partial<
    Record<AeoConsumerSurface | AeoCustomSurface, ProbeBinding>
  > = {};

  for (const surface of Object.keys(frozen)) {
    if (isCustomSurface(surface) || isConsumerSurface(surface)) {
      optional[surface] = available(surface);
    }
  }

  const bindings: RunBindings = {
    chatgpt: available('chatgpt'),
    gemini: available('gemini'),
    claude: available('claude'),
    perplexity: available('perplexity'),
    google_ai_overview: available('google_ai_overview'),
    claude_code: available('claude_code'),
    codex: available('codex'),
    cursor: available('cursor'),
    ...optional,
  };

  return bindings;
};

/** The adapter a banked answer was captured with: the one its capture
 * metadata names, or, when it names none, its surface's legacy adapter. */
export const capturedAdapterOf = (
  record: CapturedUnitRecord,
): string | undefined => {
  return (
    record.captureMetadata?.adapter ?? legacyBindingOf(record.surface)?.adapter
  );
};

/** The model a banked answer was asked of: the one its capture metadata
 * records, or, without metadata, its surface's legacy model. */
const capturedModelOf = (record: CapturedUnitRecord): string | undefined => {
  return record.captureMetadata
    ? (record.captureMetadata.requestedModel ?? undefined)
    : legacyBindingOf(record.surface)?.model;
};

/** The models `surface`'s captured answers were asked of, in ID order. */
export const askedModelsOn = (
  captured: readonly CapturedUnitRecord[],
  surface: AeoSurface,
): string[] => {
  return [
    ...new Set(
      captured
        .filter((record) => record.surface === surface)
        .flatMap((record) => capturedModelOf(record) ?? []),
    ),
  ].sort();
};

/** The models `surface`'s captured answers were reported as answered by,
 * in ID order: for a scraped consumer app, what the scraper read. */
export const reportedModelsOn = (
  captured: readonly CapturedUnitRecord[],
  surface: AeoSurface,
): string[] => {
  return [
    ...new Set(
      captured
        .filter((record) => record.surface === surface)
        .flatMap((record) => record.captureMetadata?.reportedModel ?? []),
    ),
  ].sort();
};

/**
 * surfaceLabelOverrides names the model in the label of every surface whose
 * captured answers were not asked of its default model (open models spec
 * §4): the default label claims the free-tier pin. Every declared custom
 * surface gets its own label. Empty for a run on the defaults, whose
 * snapshot then carries no labels at all.
 */
export const surfaceLabelOverrides = (
  captured: readonly CapturedUnitRecord[],
  /** The custom surfaces the config declares, with their labels. */
  declared: readonly { key: string; label: string }[] = [],
): Record<string, string> => {
  const askedOn = (surface: AeoSurface) => askedModelsOn(captured, surface);
  const labels: Record<string, string> = {};

  for (const surface of modelBoundSurfaces) {
    const own: ProbeBinding = defaultProbeBindings[surface];
    const asked = askedOn(surface);

    if (asked.length > 0 && asked.some((model) => model !== own.model)) {
      labels[surface] = (surfaceLabels[surface] ?? surface).replace(
        /\)$/,
        `, ${asked.join(', ')})`,
      );
    }
  }

  // A custom surface is always labelled: the audit's own label, and the
  // model its captured answers were asked of.
  for (const { key, label } of declared) {
    const asked = askedOn(customSurfaceId(key));

    labels[customSurfaceId(key)] =
      asked.length === 0 ? label : `${label} (${asked.join(', ')})`;
  }

  return labels;
};

/**
 * bankBindingMismatches lists the banked answers a run cannot reuse: those
 * taken with another adapter than the surface's frozen binding, or asked of
 * another model when the binding names one. Unit keys carry neither, so
 * without this check a changed binding would reuse answers measured
 * another way.
 */
export const bankBindingMismatches = (
  records: readonly CapturedUnitRecord[],
  bindings: RunBindings,
): CapturedUnitRecord[] => {
  return records.filter((record) => {
    const binding = bindingOf(bindings, record.surface);

    return (
      capturedAdapterOf(record) !== binding.adapter ||
      (binding.model !== undefined && capturedModelOf(record) !== binding.model)
    );
  });
};

/** createChatAdapter is the adapter `surface` is bound to by default, asking
 * in the run's market. */
export const createChatAdapter = (
  surface: AeoApiSurface,
  {
    geography,
    language,
    dependencies,
  }: { geography: string; language: string; dependencies: ProbeDependencies },
): ProbeAdapter => {
  const binding = bindingOf(dependencies.bindings, surface);
  const registered = dependencies.registry?.(surface, binding);

  if (registered) {
    // The capture metadata, the reservation and the journal all name the
    // run's binding: an adapter registered for it implements that binding,
    // never another.
    if (
      registered.surface !== surface ||
      registered.id !== binding.adapter ||
      registered.model !== binding.model
    ) {
      throw new Error(
        `The adapter registered for ${surface} is ${registered.surface} with ${registered.id} (${registered.model ?? 'no model'}), not the run's binding of ${binding.adapter} (${binding.model ?? 'no model'}). A registry implements the frozen binding it is handed.`,
      );
    }

    return registered;
  }

  switch (binding.adapter) {
    case ProbeAdapterId.GATEWAY_OPENAI:
    case ProbeAdapterId.GATEWAY_GOOGLE:
    case ProbeAdapterId.GATEWAY_ANTHROPIC:
    case ProbeAdapterId.GATEWAY_SEARCH:
      return createGatewayChatAdapter(binding.adapter, {
        surface,
        gateway: dependencies.gateway,
        model: requireModel(binding, surface),
        market: { geography, language },
      });

    case ProbeAdapterId.GATEWAY_PERPLEXITY:
      return createGatewayPerplexityAdapter({
        surface,
        gateway: dependencies.gateway,
        model: requireModel(binding, surface),
      });

    case ProbeAdapterId.DATAFORSEO_AI_OVERVIEW:
      return createDataForSeoAiOverviewAdapter({
        surface,
        client: dependencies.dataForSeo,
        locale: plannedLocale(geography, language),
      });

    case ProbeAdapterId.DATAFORSEO_AI_MODE:
      return createDataForSeoAiModeAdapter({
        surface,
        client: dependencies.dataForSeo,
        locale: plannedLocale(geography, language),
      });

    case ProbeAdapterId.DATAFORSEO_CHATGPT_APP:
      return createDataForSeoChatGptAppAdapter({
        surface,
        client: dependencies.dataForSeo,
        locale: plannedLocale(geography, language),
      });

    case ProbeAdapterId.CLI_CLAUDE_CODE:
    case ProbeAdapterId.CLI_CODEX:
    case ProbeAdapterId.CLI_CURSOR:
      throw new Error(
        `Chat surface ${surface} is bound to a coding-agent adapter: ${binding.adapter}.`,
      );

    default: {
      const unhandled: never = binding.adapter;

      throw new Error(`Unhandled probe adapter: ${String(unhandled)}.`);
    }
  }
};

// planRun refuses an unmapped market before anything runs.
const plannedLocale = (
  geography: string,
  language: string,
): DataForSeoLocale => {
  const locale = resolveDataForSeoLocale(geography, language);

  if (!locale) {
    throw new Error(
      `No DataForSEO market for geography ${geography} and language ${language}; the plan should have refused this run.`,
    );
  }

  return locale;
};

const requireModel = (binding: ProbeBinding, surface: AeoSurface): string => {
  if (binding.model === undefined) {
    throw new Error(
      `The binding of ${surface} names no model for ${binding.adapter}.`,
    );
  }

  return binding.model;
};
