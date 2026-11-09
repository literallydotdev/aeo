import { createGateway } from '@ai-sdk/gateway';
import { toolVersion } from '../bundle/contracts';
import type { CapturedUnitRecord } from '../stores/ports';
import { allSurfaces, type AeoChatSurface, type AeoSurface } from '../surfaces';
import {
  ProbeAdapterId,
  type ChatModelProvider,
  type ProbeAdapter,
  type ProbeAdapterProfile,
} from './adapter';
import { cliAdapterProfiles } from './adapters/cli-agents';
import {
  createDataForSeoAiOverviewAdapter,
  dataForSeoAiOverviewProfile,
} from './adapters/dataforseo-ai-overview';
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

/** A run's frozen bindings: one per surface. */
export type RunBindings = Readonly<Record<AeoSurface, ProbeBinding>>;

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
  surface: AeoChatSurface,
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

export const defaultProbeBindings: RunBindings = legacyProbeBindings;

/** Every registered adapter's profile, by ID. */
export const probeAdapterProfiles: Readonly<
  Record<ProbeAdapterId, ProbeAdapterProfile>
> = {
  [ProbeAdapterId.GATEWAY_OPENAI]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_OPENAI],
  [ProbeAdapterId.GATEWAY_GOOGLE]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_GOOGLE],
  [ProbeAdapterId.GATEWAY_ANTHROPIC]:
    gatewayChatProfiles[ProbeAdapterId.GATEWAY_ANTHROPIC],
  [ProbeAdapterId.GATEWAY_PERPLEXITY]: gatewayPerplexityProfile,
  [ProbeAdapterId.DATAFORSEO_AI_OVERVIEW]: dataForSeoAiOverviewProfile,
  [ProbeAdapterId.CLI_CLAUDE_CODE]: cliAdapterProfiles.claude_code,
  [ProbeAdapterId.CLI_CODEX]: cliAdapterProfiles.codex,
  [ProbeAdapterId.CLI_CURSOR]: cliAdapterProfiles.cursor,
};

/** The profile of the adapter a binding names. */
export const profileOf = (binding: ProbeBinding): ProbeAdapterProfile => {
  return probeAdapterProfiles[binding.adapter];
};

// The bindings the engine runs: its defaults, and the legacy table a
// directory from before bindings is frozen with. Until a method release
// they are the same table and the only bindings a run can have (probe
// adapters spec §4.5): a frozen file naming any other adapter, surface or
// model is refused, never measured.
const availableBinding = (
  surface: AeoSurface,
  binding: { adapter: string; model?: string },
): ProbeBinding | undefined => {
  const known: readonly ProbeBinding[] = [
    defaultProbeBindings[surface],
    legacyProbeBindings[surface],
  ];

  return known.find(
    (candidate) =>
      candidate.adapter === binding.adapter &&
      candidate.model === binding.model,
  );
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
    (surface) => !allSurfaces.some((known) => known === surface),
  );

  if (unknown.length > 0) {
    throw new RunBindingsError(
      `This run directory binds surfaces literally-aeo ${toolVersion} does not measure: ${unknown.join(', ')}. Please resume it with the release that started it.`,
    );
  }

  const entries = allSurfaces.map((surface) => {
    const binding = frozen[surface];

    if (!binding) {
      throw new RunBindingsError(
        `This run directory's frozen bindings name no adapter for ${surface}. Please resume it with the release that started it.`,
      );
    }

    const available = availableBinding(surface, binding);

    if (!available) {
      const named =
        binding.model === undefined
          ? binding.adapter
          : `${binding.adapter} with ${binding.model}`;

      throw new RunBindingsError(
        `This run directory measures ${surface} with ${named}, which literally-aeo ${toolVersion} cannot run. Please resume it with a release that has that binding; a run never changes how a surface is measured.`,
      );
    }

    return [surface, available] as const;
  });

  const bindings: RunBindings = {
    chatgpt: requireEntry(entries, 'chatgpt'),
    gemini: requireEntry(entries, 'gemini'),
    claude: requireEntry(entries, 'claude'),
    perplexity: requireEntry(entries, 'perplexity'),
    google_ai_overview: requireEntry(entries, 'google_ai_overview'),
    claude_code: requireEntry(entries, 'claude_code'),
    codex: requireEntry(entries, 'codex'),
    cursor: requireEntry(entries, 'cursor'),
  };

  return bindings;
};

const requireEntry = (
  entries: ReadonlyArray<readonly [AeoSurface, ProbeBinding]>,
  surface: AeoSurface,
): ProbeBinding => {
  const entry = entries.find(([key]) => key === surface);

  if (!entry) {
    throw new Error(`No binding was resolved for ${surface}.`);
  }

  return entry[1];
};

/** The adapter a banked answer was captured with: the one its capture
 * metadata names, or, when it names none, its surface's legacy adapter. */
export const capturedAdapterOf = (record: CapturedUnitRecord): string => {
  return (
    record.captureMetadata?.adapter ??
    legacyProbeBindings[record.surface].adapter
  );
};

/**
 * bankBindingMismatches lists the banked answers a run cannot reuse: those
 * taken with another adapter than the surface's frozen binding. Unit keys
 * do not carry the adapter, so without this check a changed binding would
 * reuse answers measured another way.
 */
export const bankBindingMismatches = (
  records: readonly CapturedUnitRecord[],
  bindings: RunBindings,
): CapturedUnitRecord[] => {
  return records.filter(
    (record) => capturedAdapterOf(record) !== bindings[record.surface].adapter,
  );
};

/** createChatAdapter is the adapter `surface` is bound to by default, asking
 * in the run's market. */
export const createChatAdapter = (
  surface: AeoChatSurface,
  {
    geography,
    language,
    dependencies,
  }: { geography: string; language: string; dependencies: ProbeDependencies },
): ProbeAdapter => {
  const binding = dependencies.bindings[surface];
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
      return createGatewayChatAdapter(binding.adapter, {
        surface,
        gateway: dependencies.gateway,
        model: requireModel(binding, surface),
      });

    case ProbeAdapterId.GATEWAY_PERPLEXITY:
      return createGatewayPerplexityAdapter({
        surface,
        gateway: dependencies.gateway,
        model: requireModel(binding, surface),
      });

    case ProbeAdapterId.DATAFORSEO_AI_OVERVIEW: {
      const locale = resolveDataForSeoLocale(geography, language);

      // planRun refuses an unmapped market before anything runs.
      if (!locale) {
        throw new Error(
          `No DataForSEO market for geography ${geography} and language ${language}; the plan should have refused this run.`,
        );
      }

      return createDataForSeoAiOverviewAdapter({
        surface,
        client: dependencies.dataForSeo,
        locale,
      });
    }

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

const requireModel = (binding: ProbeBinding, surface: AeoSurface): string => {
  if (binding.model === undefined) {
    throw new Error(
      `The binding of ${surface} names no model for ${binding.adapter}.`,
    );
  }

  return binding.model;
};
