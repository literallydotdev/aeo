import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AiModule from 'ai';
import { readEnv, requireEnv } from '../lib/env';
import { servedModelOf } from '../models/served-model';
import type { AeoApiSurface } from '../surfaces';
import {
  bindingOf,
  createChatAdapter,
  customSurfaceId,
  defaultProbeBindings,
  modelBoundSurfaces,
  probeDependenciesOf,
  requestedBindingsOf,
  type RunBindings,
} from './bindings';

// ============================================================================
// PAID, maintainer-run (.claude/rules/tests-cost-nothing.md): one real answer
// per default probe model, and one through gateway.search@1 with a model of
// a provider that has no adapter of its own. Five gateway calls, a few cents
// each, plus a synthesis follow-up for any that returns no prose.
//
// Each canary asks through the adapter a run would build, so a pass says
// the pinned model answers, searched, and what the gateway named as the
// served model. Each also writes what the AI SDK returned for its first
// call (`steps[].content` and `providerMetadata`, the shape the fixtures in
// __fixtures__/chat pin) to AEO_LIVE_OUTPUT_DIR, which must lie outside the
// repository: a capture holds real pages and names, and becomes a fixture
// only after a maintainer has scrubbed it.
//
//   AI_GATEWAY_API_KEY=... AEO_LIVE_OUTPUT_DIR=/path/outside/the/repo \
//     capped npx vitest run --config vitest.live.config.ts
// ============================================================================

type StreamOptions = Parameters<typeof AiModule.streamText>[0];
type StreamResult = ReturnType<typeof AiModule.streamText>;

const streams: StreamResult[] = [];

// The real streamText, with each result kept: the adapter's own request is
// what gets captured, never a copy of it written here.
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof AiModule>('ai');

  return {
    ...actual,
    streamText: (options: StreamOptions) => {
      const result = actual.streamText(options);
      streams.push(result);

      return result;
    },
  };
});

// The question the existing chat fixtures were captured with: public,
// answerable only by searching, and about no company.
const question = 'What is the current LTS version of Node.js?';
const market = { geography: 'US', language: 'en' };

const customKey = 'canary';
const defaultCustomModel = 'mistral/mistral-large-4';

type Canary = { surface: AeoApiSurface; bindings: RunBindings };

const canaries = (): readonly Canary[] => {
  const customModel = readEnv('AEO_LIVE_CUSTOM_MODEL') ?? defaultCustomModel;

  return [
    ...modelBoundSurfaces.map((surface) => ({
      surface,
      bindings: defaultProbeBindings,
    })),
    {
      surface: customSurfaceId(customKey),
      bindings: requestedBindingsOf({}, [
        { key: customKey, model: customModel },
      ]),
    },
  ];
};

describe('default bindings (live, paid)', () => {
  let apiKey: string;
  let outputDir: string;

  beforeAll(() => {
    apiKey = requireEnv('AI_GATEWAY_API_KEY');
    outputDir = path.resolve(
      requireEnv(
        'AEO_LIVE_OUTPUT_DIR',
        'Please set AEO_LIVE_OUTPUT_DIR to a directory outside the repository; the captures are written there.',
      ),
    );

    const repository = path.resolve(import.meta.dirname, '..', '..');

    if (!path.relative(repository, outputDir).startsWith('..')) {
      throw new Error(
        `AEO_LIVE_OUTPUT_DIR is inside the repository (${outputDir}). A raw capture is not fit to commit; name a directory outside it.`,
      );
    }

    mkdirSync(outputDir, { recursive: true });
  });

  it.each(canaries())(
    'should answer from a search on $surface',
    async ({ surface, bindings }) => {
      const binding = bindingOf(bindings, surface);
      const adapter = createChatAdapter(surface, {
        ...market,
        dependencies: probeDependenciesOf(
          { AI_GATEWAY_API_KEY: apiKey },
          bindings,
        ),
      });
      const firstStream = streams.length;
      const answer = await adapter.probe(question, {});
      const first = streams[firstStream];
      const [steps, providerMetadata] = first
        ? await Promise.all([first.steps, first.providerMetadata])
        : [[], undefined];
      const sourceCount =
        answer.sources.format === 'search' ? answer.sources.sources.length : 0;
      const requestedModel = binding.model ?? '';

      writeFileSync(
        path.join(outputDir, `${surface.replace(':', '-')}.json`),
        `${JSON.stringify(
          {
            surface,
            adapter: adapter.id,
            requestedModel,
            // As the provider named it; null when it only echoed the request.
            servedModel:
              servedModelOf(requestedModel, answer.servedModel) ?? null,
            calls: streams.length - firstStream,
            reportedCostUsd: answer.reportedCostUsd ?? null,
            answerChars: answer.answerText.length,
            sourceCount,
            retrieval: answer.retrieval,
            answerText: answer.answerText,
            steps: steps.map((step) => ({ content: step.content })),
            providerMetadata,
          },
          null,
          2,
        )}\n`,
      );

      expect(answer.answerText.trim()).not.toBe('');

      if (adapter.observes.retrieval === 'none') {
        // Perplexity exposes no queries; its sources are its only trace.
        expect(sourceCount).toBeGreaterThan(0);
      } else {
        // null is an extractor miss: the model searched, as the request
        // requires, and the adapter's parsing did not read the result.
        expect(answer.retrieval?.calls.length ?? 0).toBeGreaterThan(0);
      }
    },
  );
});
