import type * as gatewayModule from '@ai-sdk/gateway';
import type * as ai from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NoObjectGeneratedError } from 'ai';
import { createMemoryModelAccounting } from './accounting';
import { resolveInternalModelProfile } from './profiles';
import {
  StructuredOutputMissingError,
  generateStructured,
  type StructuredCallObservation,
} from './structured';

// A provider can answer, be billed, and still produce nothing matching the
// response schema. The billed generation must be retained and settled, never
// left as an open reservation with its text discarded.

const provider = vi.hoisted(() => ({
  generateText: vi.fn(),
  gateway: vi.fn((id: string) => `gateway:${id}`),
}));

vi.mock('ai', async () => {
  const { streamedResult } = await import('./stream-result-fixture');

  return {
    ...(await vi.importActual<typeof ai>('ai')),
    // The transport streams; these tests describe one settled answer.
    streamText: (options: unknown) =>
      streamedResult(provider.generateText(options)),
  };
});

vi.mock('@ai-sdk/gateway', async () => ({
  ...(await vi.importActual<typeof gatewayModule>('@ai-sdk/gateway')),
  gateway: provider.gateway,
  createGateway: () => provider.gateway,
}));

const prose = 'Here is the report copy, written as prose instead of JSON.';

const createBilledAnswer = (finishReason: 'stop' | 'length' = 'stop') => {
  return {
    text: prose,
    usage: {
      inputTokens: 1200,
      outputTokens: 3400,
      inputTokenDetails: { cacheReadTokens: 64 },
      outputTokenDetails: { reasoningTokens: 900 },
    },
    response: { id: 'request-1', modelId: 'accounts/fireworks/models/glm-5p3' },
    finishReason,
    providerMetadata: { gateway: { cost: '0.0421' } },
    toolCalls: [],
  };
};

/**
 * createUnmatchedAnswer returns the shape the SDK returns when nothing
 * matched. Streaming rejects the output promise with NoObjectGeneratedError
 * while every sibling member resolves; the thrown getter here becomes exactly
 * that rejection through `streamedResult`. Modelling it as
 * NoOutputGeneratedError, which is the non-streaming shape, is what hid the
 * transport's mis-caught error class.
 */
const createUnmatchedAnswer = (finishReason: 'stop' | 'length' = 'stop') => {
  return {
    ...createBilledAnswer(finishReason),
    get output(): never {
      throw new NoObjectGeneratedError({
        message: 'No object generated: response did not match schema.',
        text: prose,
        response: {
          id: 'request-1',
          modelId: 'accounts/fireworks/models/glm-5p3',
          timestamp: new Date(0),
        },
        usage: createBilledAnswer(finishReason).usage as never,
        finishReason,
      });
    },
  };
};

const createCall = () => {
  const accounting = createMemoryModelAccounting({
    maxUsd: 100,
    maxTokens: 1_000_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });

  const observations: StructuredCallObservation[] = [];

  const input = {
    roleName: 'copy',
    role: resolveInternalModelProfile('glm-harness-v1', {}).roles.copy,
    schema: z.object({ headline: z.string() }).strict(),
    prompt: 'Write the report copy.',
    accounting,
    journal: {
      observe: (observation: StructuredCallObservation) => {
        observations.push(observation);

        return Promise.resolve();
      },
    },
  };

  return { input, accounting, observations };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('structured - generateStructured() with a billed answer that matches no schema', () => {
  it('should retain the response and settle its reported cost instead of stranding the reservation', async () => {
    const { input, accounting, observations } = createCall();

    provider.generateText.mockResolvedValue(createUnmatchedAnswer());

    await expect(generateStructured(input)).rejects.toThrow(
      'no value matching the response schema',
    );

    const [settled] = Object.values(accounting.state.calls);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      payload: null,
      text: prose,
      valid: false,
    });
    expect(settled?.usage).toMatchObject({
      costUsd: 0.0421,
      inputTokens: 1200,
      outputTokens: 3400,
      cachedInputTokens: 64,
      reasoningTokens: 900,
      resolvedModel: 'accounts/fireworks/models/glm-5p3',
      requestId: 'request-1',
    });
  });

  it('should report a clipped answer as an output limit, still settling what it cost', async () => {
    const { input, accounting } = createCall();

    provider.generateText.mockResolvedValue(createUnmatchedAnswer('length'));

    await expect(generateStructured(input)).rejects.toThrow(
      'model_output_limit',
    );
    expect(Object.values(accounting.state.calls)[0]?.usage?.finishReason).toBe(
      'length',
    );
  });

  it('should leave a matching answer untouched', async () => {
    const { input, accounting, observations } = createCall();

    provider.generateText.mockResolvedValue({
      ...createBilledAnswer(),
      output: { headline: 'A measured headline' },
    });

    const result = await generateStructured(input);

    expect(result.output).toEqual({ headline: 'A measured headline' });
    expect(observations[0]?.valid).toBe(true);
    expect(Object.values(accounting.state.calls)[0]?.usage?.costUsd).toBe(
      0.0421,
    );
  });
});

describe('structured - generateStructured() with an answer given as a tool call', () => {
  it('should retain the tool calls as the text of the schema miss', async () => {
    // Opus 5 through the gateway answered a planner turn with a native tool
    // call (finish tool-calls, empty text) three times on 2026-09-12; the
    // miss carried nothing to read. The call is the answer, so it is kept.
    const { input } = createCall();
    const base = createBilledAnswer();

    provider.generateText.mockResolvedValue({
      ...base,
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolName: 'inspect_status', input: { chunkId: 'c1' } }],
      get output(): never {
        throw new NoObjectGeneratedError({
          message: 'No object generated: could not parse the response.',
          text: '',
          response: { ...base.response, timestamp: new Date(0) },
          usage: base.usage as never,
          finishReason: 'tool-calls',
        });
      },
    });

    const error = await generateStructured(input).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StructuredOutputMissingError);
    expect((error as StructuredOutputMissingError).text).toBe(
      JSON.stringify([{ tool: 'inspect_status', input: { chunkId: 'c1' } }]),
    );
  });
});

describe('structured - generateStructured() with a tool call naming a schema action', () => {
  it('should decode the call as that action', async () => {
    // Opus 5 through the gateway called `inspect_dependencies` natively on
    // a planner turn (2026-09-13); the call is the action the schema names.
    const { input } = createCall();
    const turn = z.discriminatedUnion('action', [
      z
        .object({
          action: z.literal('tool:inspect_dependencies'),
          input: z.object({ nodeKey: z.string() }),
        })
        .strict(),
      z.object({ action: z.literal('finish') }).strict(),
    ]);
    const base = createBilledAnswer();

    provider.generateText.mockResolvedValue({
      ...base,
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        {
          toolName: 'inspect_dependencies',
          input: { nodeKey: 'analysis:s1:p1' },
        },
      ],
      get output(): never {
        throw new NoObjectGeneratedError({
          message: 'No object generated: could not parse the response.',
          text: '',
          response: { ...base.response, timestamp: new Date(0) },
          usage: base.usage as never,
          finishReason: 'tool-calls',
        });
      },
    });

    const result = await generateStructured({ ...input, schema: turn });

    expect(result.output).toEqual({
      action: 'tool:inspect_dependencies',
      input: { nodeKey: 'analysis:s1:p1' },
    });
  });
});

describe('structured - generateStructured() with a route that refuses the request', () => {
  // Measured 2026-09-12: the DeepInfra route for DeepSeek V4.1 Flash ended
  // the stream with finish reason "error" and no text, three times in a
  // row, and the failure looked identical to a schema miss. The error must
  // carry the route and how it ended so the log names it.
  it('should report the resolved route, the error finish and zero output on the refusal', async () => {
    const { input, accounting } = createCall();
    const usage = {
      inputTokens: 11855,
      outputTokens: 0,
      inputTokenDetails: { cacheReadTokens: 0 },
      outputTokenDetails: { reasoningTokens: 0 },
    };

    const response = {
      id: 'request-2',
      modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
    };

    provider.generateText.mockResolvedValue({
      text: '',
      usage,
      response,
      finishReason: 'error',
      providerMetadata: { gateway: { cost: '0.002371' } },
      toolCalls: [],
      get output(): never {
        throw new NoObjectGeneratedError({
          message: 'No object generated: could not parse the response.',
          text: '',
          response: { ...response, timestamp: new Date(0) },
          usage: usage as never,
          finishReason: 'error',
        });
      },
    });

    const error = await generateStructured(input).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StructuredOutputMissingError);
    expect(error).toMatchObject({
      text: '',
      usage: {
        resolvedModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
        finishReason: 'error',
        outputTokens: 0,
        costUsd: 0.002371,
      },
    });
    expect(Object.values(accounting.state.calls)[0]?.usage?.finishReason).toBe(
      'error',
    );
  });
});
