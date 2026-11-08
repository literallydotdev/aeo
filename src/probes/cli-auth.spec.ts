import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentAuthEnv, runAgentProbesForPrompts } from './agent-clis';
import {
  createFakeCliHost,
  stubAgentEnvironment,
  type FakeCliHost,
} from './__fixtures__/golden-harness';
import { unlimited } from './limits';

// ============================================================================
// A coding agent's child environment (hardening spec §4.5): it carries every
// auth variable preflight accepts for that CLI, so a run that passes
// preflight can authenticate, and none of the parent's other secrets. The
// fake CLI answers with the environment it was started with.
// ============================================================================

const prompt = { id: 'p1', promptText: 'Which file store?', category: 'x' };

const parentEnv = {
  // Every agent's auth variables, with values the dump can be matched on.
  CLAUDE_CODE_OAUTH_TOKEN: 'fake-claude-token',
  ANTHROPIC_API_KEY: 'fake-anthropic-key',
  OPENAI_API_KEY: 'fake-openai-key',
  CODEX_HOME: '/fake/codex-home',
  CURSOR_API_KEY: 'fake-cursor-key',
  // Secrets no CLI may see.
  AI_GATEWAY_API_KEY: 'fake-gateway-key',
  DATAFORSEO_PASSWORD: 'fake-dataforseo-password',
};

let host: FakeCliHost;

beforeAll(async () => {
  host = await createFakeCliHost();
  stubAgentEnvironment(host);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(host.root, { recursive: true, force: true });
});

describe('agent-clis - the CLI child environment', () => {
  it.each(['claude_code', 'codex', 'cursor'] as const)(
    'should hand %s every auth variable preflight accepts and no other secret',
    async (surface) => {
      const { outcomes } = await runAgentProbesForPrompts({
        prompts: [prompt],
        surfaces: [surface],
        versions: { claudeCode: 'fake', codex: 'fake', cursor: 'fake' },
        runsPerPrompt: 1,
        runtime: await host.runtime({ mode: 'env-dump', env: parentEnv }),
        limiter: unlimited(),
      });
      const [outcome] = outcomes;

      if (outcome?.status !== 'captured') {
        throw new Error(`The ${surface} probe was not captured.`);
      }

      const childEnv = JSON.parse(outcome.probe.text) as Record<string, string>;
      const secretNames = Object.keys(parentEnv);
      const received = secretNames.filter((name) => name in childEnv).sort();

      expect(received).toEqual([...agentAuthEnv[surface].anyOf].sort());
    },
  );
});
