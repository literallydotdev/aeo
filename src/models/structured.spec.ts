import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GatewayInternalServerError } from '@ai-sdk/gateway';
import {
  createMemoryModelAccounting,
  type ModelCallAccounting,
} from './accounting';
import { testModelProfileFixture } from './profile-fixture';
import { ModelCallAbortError } from './errors';
import {
  generateStructured,
  structuredCallReservation,
  type StructuredCallInput,
  type StructuredTransport,
} from './structured';

const createFixture = () => {
  const accounting = createMemoryModelAccounting({
    maxUsd: 100,
    maxTokens: 1_000_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });

  const input: StructuredCallInput<{ valid: boolean }> = {
    roleName: 'adjudication',
    role: testModelProfileFixture().roles.adjudication,
    schema: z.object({ valid: z.boolean() }).strict(),
    prompt: 'Evaluate these saved passages.',
    accounting,
  };

  return { input, accounting };
};

describe('structured - generateStructured()', () => {
  const creditMessage =
    'A positive credit balance is required for all requests, including BYOK, so fallback providers remain available. Add credits at https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up to continue.';

  it('should settle a proven Gateway credit refusal at zero so a funded retry can use the original budget', async () => {
    const { input } = createFixture();
    const reservation = structuredCallReservation(input);
    const accounting = createMemoryModelAccounting({
      maxUsd: reservation.reservedUsd,
      maxTokens: reservation.inputTokens + reservation.maxOutputTokens,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });

    const refusal = new GatewayInternalServerError({
      statusCode: 402,
      message: creditMessage,
      generationId: 'credit-rejection',
    });

    const rejected = vi.fn<() => Promise<never>>().mockRejectedValue(refusal);

    await expect(
      generateStructured({ ...input, accounting }, rejected),
    ).rejects.toBe(refusal);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(Object.values(accounting.state.calls)[0]?.usage).toMatchObject({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      finishReason: 'gateway_credit_refused',
    });

    const funded: StructuredTransport = (current) => {
      return Promise.resolve({
        output: current.schema.parse({ valid: true }),
        usage: { costUsd: 0.01, inputTokens: 10, outputTokens: 10 },
      });
    };

    expect(
      (await generateStructured({ ...input, accounting }, funded)).output,
    ).toEqual({ valid: true });
    expect(Object.values(accounting.state.calls)).toHaveLength(2);
  });

  it.each([
    [
      'unrecognized Gateway 402',
      new GatewayInternalServerError({
        statusCode: 402,
        message: 'Payment required after upstream failure',
      }),
    ],
    [
      'Gateway 500 with the same message',
      new GatewayInternalServerError({
        statusCode: 500,
        message: creditMessage,
      }),
    ],
    [
      'unbranded error with matching fields',
      Object.assign(new Error(creditMessage), {
        name: 'GatewayInternalServerError',
        statusCode: 402,
      }),
    ],
    [
      'wrapped Gateway credit refusal',
      new Error('Dispatch result unknown', {
        cause: new GatewayInternalServerError({
          statusCode: 402,
          message: creditMessage,
        }),
      }),
    ],
  ])('should retain indeterminate usage for %s', async (_name, error) => {
    const { input, accounting } = createFixture();

    const result = generateStructured(input, () => Promise.reject(error));

    await expect(result).rejects.toBe(error);
    expect(Object.values(accounting.state.calls)[0]?.usage).toBeUndefined();
  });

  it('should retain a credit-refusal reservation if ownership was lost before settlement', async () => {
    const { input, accounting } = createFixture();
    const refusal = new GatewayInternalServerError({
      statusCode: 402,
      message: creditMessage,
    });

    const assertOwned = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fenced'));

    await expect(
      generateStructured(
        { ...input, accounting: { ...accounting, assertOwned } },
        () => Promise.reject(refusal),
      ),
    ).rejects.toThrow('fenced');
    expect(Object.values(accounting.state.calls)[0]?.usage).toBeUndefined();
  });

  it('should preserve a host timeout when a late credit refusal arrives', async () => {
    const { input, accounting } = createFixture();
    const refusal = new GatewayInternalServerError({
      statusCode: 402,
      message: creditMessage,
    });

    const transport: StructuredTransport = ({ signal }) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(refusal), { once: true });
      });
    };

    await expect(
      generateStructured(
        { ...input, role: { ...input.role, deadlineMs: 10 } },
        transport,
      ),
    ).rejects.toMatchObject({
      name: 'ModelCallAbortError',
      reason: 'deadline',
      cause: refusal,
    });
    expect(Object.values(accounting.state.calls)[0]?.usage).toBeUndefined();
  });

  it('should reserve and check ownership before dispatch, then retains requested/resolved usage', async () => {
    const { input, accounting } = createFixture();
    const events: string[] = [];
    const hooks: ModelCallAccounting = {
      reserve: async (call) => {
        events.push('reserve');
        await accounting.reserve(call);
      },
      assertOwned: () => {
        events.push('owned');

        return Promise.resolve();
      },
      settle: async (id, usage) => {
        events.push('settle');
        await accounting.settle(id, usage);
      },
    };

    const transport: StructuredTransport = (current) => {
      events.push('dispatch');

      expect(Object.keys(accounting.state.calls)).toHaveLength(1);

      return Promise.resolve({
        output: current.schema.parse({ valid: true }),
        usage: {
          resolvedModel: 'reported-snapshot',
          costUsd: 0.1,
          inputTokens: 123,
          outputTokens: 456,
          reasoningTokens: 200,
          requestId: 'request',
          finishReason: 'stop',
        },
      });
    };

    const result = await generateStructured(
      { ...input, accounting: hooks },
      transport,
    );

    expect(events).toEqual(['reserve', 'owned', 'dispatch', 'owned', 'settle']);
    expect(result.usage.requestedModel).toBe(input.role.model);
    expect(result.usage.reasoningEffort).toBe('high');
    expect(Object.values(accounting.state.calls)[0]?.usage?.costUsd).toBe(0.1);
  });

  it('should NOT retry unavailable models or release indeterminate spend', async () => {
    const { input, accounting } = createFixture();
    const transport = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error('model unavailable'));

    await expect(generateStructured(input, transport)).rejects.toThrow(
      'model unavailable',
    );
    expect(transport).toHaveBeenCalledTimes(1);

    const calls = Object.values(accounting.state.calls);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.usage).toBeUndefined();
    expect(calls[0]?.reservedUsd).toBeGreaterThan(0);
  });

  it('should preserve a host deadline when the provider wraps its abort as HTTP 500', async () => {
    const { input, accounting } = createFixture();
    const providerError = Object.assign(new Error('provider response'), {
      name: 'GatewayResponseError',
      statusCode: 500,
    });

    const transport: StructuredTransport = ({ signal }) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(providerError), {
          once: true,
        });
      });
    };
    const result = generateStructured(
      { ...input, role: { ...input.role, deadlineMs: 10 } },
      transport,
    );

    await expect(result).rejects.toMatchObject({
      name: 'ModelCallAbortError',
      reason: 'deadline',
      cause: providerError,
    });

    const calls = Object.values(accounting.state.calls);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.usage).toBeUndefined();
    expect(calls[0]?.reservedUsd).toBeGreaterThan(0);
  });

  it('should preserve host cancellation and leaves ordinary provider failures unchanged', async () => {
    const { input } = createFixture();
    const cancellation = new AbortController();
    const providerError = Object.assign(new Error('provider response'), {
      statusCode: 500,
    });

    const cancelled: StructuredTransport = () => {
      cancellation.abort();

      return Promise.reject(providerError);
    };

    await expect(
      generateStructured({ ...input, signal: cancellation.signal }, cancelled),
    ).rejects.toMatchObject({
      name: 'ModelCallAbortError',
      reason: 'cancelled',
      cause: providerError,
    });

    const ordinary: StructuredTransport = () => {
      return Promise.reject(providerError);
    };
    const result = generateStructured(input, ordinary);

    await expect(result).rejects.toBe(providerError);
    await expect(result).rejects.not.toBeInstanceOf(ModelCallAbortError);
  });

  it('should NOT return a late result when the host deadline expires during ownership verification', async () => {
    const { input, accounting } = createFixture();
    let ownershipChecks = 0;
    const hooks: ModelCallAccounting = {
      ...accounting,
      async assertOwned() {
        ownershipChecks += 1;

        if (ownershipChecks === 2) {
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        }
      },
    };

    const transport: StructuredTransport = (current) => {
      return Promise.resolve({
        output: current.schema.parse({ valid: true }),
        usage: { costUsd: 0.01, inputTokens: 10, outputTokens: 10 },
      });
    };

    await expect(
      generateStructured(
        { ...input, accounting: hooks, role: { ...input.role, deadlineMs: 5 } },
        transport,
      ),
    ).rejects.toMatchObject({
      name: 'ModelCallAbortError',
      reason: 'deadline',
    });
    expect(ownershipChecks).toBe(2);

    const calls = Object.values(accounting.state.calls);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.usage).toBeUndefined();
  });

  it('should refuse oversized input, exhausted funds and cancelled work before dispatch', async () => {
    const { input } = createFixture();
    const transport = vi.fn(() =>
      Promise.reject(new Error('Unexpected dispatch.')),
    );

    await expect(
      generateStructured(
        { ...input, prompt: 'x'.repeat(input.role.maxInputTokens + 1) },
        transport,
      ),
    ).rejects.toThrow('model_input_limit');

    const poor = createMemoryModelAccounting({
      maxUsd: 0.0001,
      maxTokens: 1_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });

    await expect(
      generateStructured({ ...input, accounting: poor }, transport),
    ).rejects.toThrow('Insufficient remaining model budget');
    await expect(
      generateStructured(
        { ...input, signal: AbortSignal.abort(new Error('cancelled')) },
        transport,
      ),
    ).rejects.toThrow('cancelled');
    expect(transport).not.toHaveBeenCalled();
  });

  it('should NOT dispatch if ownership is lost after reservation', async () => {
    const { input, accounting } = createFixture();
    const transport = vi.fn(() =>
      Promise.reject(new Error('Unexpected dispatch.')),
    );
    const fenced = {
      ...accounting,
      assertOwned: () => Promise.reject(new Error('fenced')),
    };

    await expect(
      generateStructured({ ...input, accounting: fenced }, transport),
    ).rejects.toThrow('fenced');
    expect(transport).not.toHaveBeenCalled();
    expect(Object.keys(accounting.state.calls)).toHaveLength(1);
  });

  it('should price the full output allowance including reasoning before dispatch', () => {
    const { input } = createFixture();
    const reservation = structuredCallReservation(input);

    expect(reservation.reservedUsd).toBeGreaterThan(
      (input.role.maxOutputTokens * input.role.pricingUsdPerMillion.output) /
        1_000_000,
    );
    expect(reservation.maxOutputTokens).toBe(input.role.maxOutputTokens);
  });

  it('should reject truncated output after retaining its billable usage', async () => {
    const { input, accounting } = createFixture();
    const transport: StructuredTransport = (current) => {
      return Promise.resolve({
        output: current.schema.parse({ valid: true }),
        usage: { finishReason: 'length', inputTokens: 100, outputTokens: 100 },
      });
    };

    await expect(generateStructured(input, transport)).rejects.toThrow(
      'model_output_limit',
    );
    expect(Object.values(accounting.state.calls)[0]?.usage?.finishReason).toBe(
      'length',
    );
  });
});
