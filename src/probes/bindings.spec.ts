import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  credentialSettingNames,
  engineSecretSettingNames,
} from '../engine/preflight';
import { surfaceRetrievalExposure } from '../retrieval';
import { allSurfaces } from '../surfaces';
import type { CapturedUnitRecord } from '../stores/ports';
import { ProbeAdapterId, type ProbeAdapter } from './adapter';
import { agentAuthEnv, assertAgentAuth } from './agent-clis';
import {
  createChatAdapter,
  defaultProbeBindings,
  probeAdapterProfiles,
  probeDependenciesOf,
  profileOf,
  surfaceLabelOverrides,
} from './bindings';
import { legacyProbeBindings } from './legacy-bindings';

// ============================================================================
// The bindings and the adapters' declarations (probe adapters spec §4.5 to
// §4.8, §6): what each surface is measured with, what it observes, and
// which of its settings are credentials.
// ============================================================================

describe('bindings - defaultProbeBindings', () => {
  it('should pin each API chat surface to its free-tier model, bind each consumer app to its scrape, and keep every other legacy binding', () => {
    // The method: changing a row is a method release (method release
    // spec §4), never a refactor.
    expect(defaultProbeBindings).toEqual({
      ...legacyProbeBindings,
      chatgpt: { adapter: 'gateway.openai@1', model: 'openai/gpt-6-luna' },
      claude: {
        adapter: 'gateway.anthropic@1',
        model: 'anthropic/claude-sonnet-5',
      },
      gemini: {
        adapter: 'gateway.google@1',
        model: 'google/gemini-3.5-flash-lite',
      },
      perplexity: {
        adapter: 'gateway.perplexity@1',
        model: 'perplexity/sonar',
      },
      chatgpt_app: { adapter: 'dataforseo.chatgpt_app@1' },
      google_ai_mode: { adapter: 'dataforseo.ai_mode@1' },
    });
    expect(Object.keys(defaultProbeBindings).sort()).toEqual(
      [...allSurfaces].sort(),
    );
  });

  it('should declare the same retrieval exposure as the client-safe table for every surface', () => {
    const declared = Object.fromEntries(
      allSurfaces.map((surface) => [
        surface,
        profileOf(defaultProbeBindings[surface]).observes.retrieval,
      ]),
    );

    expect(declared).toEqual(surfaceRetrievalExposure);
  });
});

describe('bindings - probeDependenciesOf()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should create the gateway and the DataForSEO client from the settings it is given', () => {
    const dependencies = probeDependenciesOf(
      {
        AI_GATEWAY_API_KEY: 'gateway-test-key',
        DATAFORSEO_LOGIN: 'login',
        DATAFORSEO_PASSWORD: 'password',
      },
      defaultProbeBindings,
    );

    expect(dependencies.bindings).toBe(defaultProbeBindings);
    expect(dependencies.gateway('openai/gpt-5.4-mini')).toMatchObject({
      modelId: 'openai/gpt-5.4-mini',
    });
    expect(dependencies.dataForSeo).toBeDefined();
  });

  it.each([
    ['no login', { DATAFORSEO_PASSWORD: 'password' }],
    ['no password', { DATAFORSEO_LOGIN: 'login' }],
  ])(
    'should create no DataForSEO client with %s, leaving preflight to name it',
    (_case, settings) => {
      expect(
        probeDependenciesOf(
          { AI_GATEWAY_API_KEY: 'gateway-test-key', ...settings },
          defaultProbeBindings,
        ).dataForSeo,
      ).toBeUndefined();
    },
  );

  it('should refuse settings without the gateway key, never letting the provider package find one elsewhere', () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'a-key-from-the-process');

    expect(() =>
      probeDependenciesOf(
        { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' },
        defaultProbeBindings,
      ),
    ).toThrow(/AI_GATEWAY_API_KEY is not set/);
  });
});

describe('bindings - createChatAdapter()', () => {
  const dependencies = {
    bindings: defaultProbeBindings,
    gateway: () => {
      throw new Error('No gateway here.');
    },
  };
  const market = { geography: 'us', language: 'en' };
  const registered = (fields: Partial<ProbeAdapter>): ProbeAdapter => {
    return {
      ...profileOf(defaultProbeBindings.chatgpt),
      surface: 'chatgpt',
      model: defaultProbeBindings.chatgpt.model,
      request: (prompt) => ({ prompt, parameters: {} }),
      probe: () => Promise.reject(new Error('Not asked here.')),
      classifyError: () => ({ kind: 'cli_error', message: 'fake' }),
      ...fields,
    };
  };

  it('should use an adapter registered for the binding the run froze', () => {
    const adapter = registered({});

    expect(
      createChatAdapter('chatgpt', {
        ...market,
        dependencies: { ...dependencies, registry: () => adapter },
      }),
    ).toBe(adapter);
  });

  it.each([
    ['another adapter', { id: ProbeAdapterId.GATEWAY_GOOGLE }],
    ['another model', { model: 'openai/gpt-test-1' }],
    ['another surface', { surface: 'gemini' as const }],
  ])(
    'should refuse a registered adapter for %s than the binding, so the evidence names one method',
    (_case, fields) => {
      expect(() =>
        createChatAdapter('chatgpt', {
          ...market,
          dependencies: {
            ...dependencies,
            registry: () => registered(fields),
          },
        }),
      ).toThrow(/not the run's binding of gateway\.openai@1/);
    },
  );
});

describe('preflight - credentialSettingNames', () => {
  it("should cover exactly the engine's secrets and every adapter's secret settings", () => {
    const adapterSecrets = Object.values(probeAdapterProfiles).flatMap(
      (profile) =>
        profile.settings
          .filter((setting) => setting.secret)
          .map((setting) => setting.name),
    );

    expect(new Set(credentialSettingNames)).toEqual(
      new Set([...engineSecretSettingNames, ...adapterSecrets]),
    );
  });

  it('should keep the names the export scanned for before adapters declared them, and no non-secret setting', () => {
    expect([...credentialSettingNames].sort()).toEqual(
      [
        'AEO_API_TOKEN',
        'AEO_DATABASE_URL',
        'AEO_SITE_DATABASE_URL',
        'AI_GATEWAY_API_KEY',
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CURSOR_API_KEY',
        'DATAFORSEO_PASSWORD',
        'GOOGLE_GENERATIVE_AI_API_KEY',
        'OPENAI_API_KEY',
        'PERPLEXITY_API_KEY',
      ].sort(),
    );
    expect(credentialSettingNames).not.toContain('DATAFORSEO_LOGIN');
    expect(credentialSettingNames).not.toContain('CODEX_HOME');
  });
});

describe('agent-clis - assertAgentAuth()', () => {
  it('should need one of a coding agent grouped auth settings in a non-interactive run, any one', () => {
    const runtimeWith = (env: Record<string, string>) => {
      return { env, claudeConfigDir: null };
    };

    expect(() => assertAgentAuth(['codex'], runtimeWith({}))).toThrow(
      /codex — one of OPENAI_API_KEY, CODEX_HOME/,
    );
    expect(() =>
      assertAgentAuth(['codex'], runtimeWith({ CODEX_HOME: '/fake/codex' })),
    ).not.toThrow();
    expect(() =>
      assertAgentAuth(
        ['claude_code'],
        runtimeWith({ ANTHROPIC_API_KEY: 'fake-anthropic-key' }),
      ),
    ).not.toThrow();
  });
});

describe('bindings - surfaceLabelOverrides()', () => {
  const askedOf = (
    surface: 'chatgpt' | 'claude' | 'codex',
    requestedModel: string | null,
  ): CapturedUnitRecord => {
    return {
      status: 'captured',
      sectionKey: 'file_stores',
      promptId: 'p1',
      promptText: 'Which store?',
      surface,
      runIndex: 1,
      capturedAt: '2026-11-10T10:00:00.000Z',
      probe: {
        promptId: 'p1',
        promptText: 'Which store?',
        promptCategory: 'comparison',
        modelName: surface,
        runIndex: 1,
        text: 'Acme Files.',
      },
      captureMetadata: { requestedModel, reportedModel: null, parameters: {} },
    };
  };

  it('should label nothing when every surface was asked of its default model', () => {
    expect(
      surfaceLabelOverrides([
        askedOf('chatgpt', defaultProbeBindings.chatgpt.model ?? null),
        askedOf('claude', defaultProbeBindings.claude.model ?? null),
        // A coding agent's CLI names its own model: never a label.
        askedOf('codex', 'gpt-test-codex'),
      ]),
    ).toEqual({});
  });

  it('should name the model in the label of a surface asked of another one, legacy models included', () => {
    expect(
      surfaceLabelOverrides([
        askedOf('chatgpt', 'openai/gpt-test-1'),
        askedOf('claude', legacyProbeBindings.claude.model),
      ]),
    ).toEqual({
      chatgpt: 'ChatGPT (API, openai/gpt-test-1)',
      claude: 'Claude (API, anthropic/claude-sonnet-4.5)',
    });
  });
});

describe('agent-clis - agentAuthEnv', () => {
  it("should accept each coding agent's auth settings, in their order", () => {
    expect({
      claude_code: agentAuthEnv.claude_code.anyOf,
      codex: agentAuthEnv.codex.anyOf,
      cursor: agentAuthEnv.cursor.anyOf,
    }).toEqual({
      claude_code: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
      codex: ['OPENAI_API_KEY', 'CODEX_HOME'],
      cursor: ['CURSOR_API_KEY'],
    });
  });
});
