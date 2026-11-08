import { describe, expect, it } from 'vitest';
import {
  credentialSettingNames,
  engineSecretSettingNames,
} from '../engine/preflight';
import { surfaceRetrievalExposure } from '../retrieval';
import { allSurfaces } from '../surfaces';
import { agentAuthEnv, assertAgentAuth } from './agent-clis';
import {
  defaultProbeBindings,
  probeAdapterProfiles,
  probeDependenciesOf,
  profileOf,
} from './bindings';
import { legacyProbeBindings } from './legacy-bindings';

// ============================================================================
// The bindings and the adapters' declarations (probe adapters spec §4.5 to
// §4.8, §6): what each surface is measured with, what it observes, and
// which of its settings are credentials.
// ============================================================================

describe('bindings - defaultProbeBindings', () => {
  it('should bind every surface to the legacy binding until a method release changes it', () => {
    expect(defaultProbeBindings).toEqual(legacyProbeBindings);
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
        probeDependenciesOf(settings, defaultProbeBindings).dataForSeo,
      ).toBeUndefined();
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
