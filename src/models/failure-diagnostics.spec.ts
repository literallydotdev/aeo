import { afterEach, describe, expect, it, vi } from 'vitest';
import { APICallError, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import { createMemoryModelAccounting } from './accounting';
import { structuredFailureDiagnostic } from './failure-diagnostics';
import { resolveInternalModelProfile } from './profiles';
import {
  generateStructured,
  StructuredOutputMissingError,
  type StructuredTransport,
} from './structured';

const secret = 'PRIVATE_SECRET_DO_NOT_LOG';

const createProviderError = (statusCode = 429) => {
  return new APICallError({
    message: secret,
    url: `https://example.com/${secret}`,
    requestBodyValues: { prompt: secret, apiKey: secret },
    statusCode,
    responseHeaders: { authorization: secret },
    responseBody: secret,
  });
};

const createSchemaError = (finishReason: 'stop' | 'length' = 'stop') => {
  return new NoObjectGeneratedError({
    message: secret,
    text: secret,
    response: { id: secret, timestamp: new Date(0), modelId: 'reported-model' },
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      inputTokenDetails: {
        noCacheTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokenDetails: { textTokens: 150, reasoningTokens: 50 },
    },
    finishReason,
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('failure-diagnostics - structuredFailureDiagnostic()', () => {
  it.each(['0', '1', undefined])(
    'should log failed response text only when debug errors is explicitly enabled (%s)',
    async (setting) => {
      vi.stubEnv('AEO_HARNESS_DEBUG_ERRORS', setting);

      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = new StructuredOutputMissingError(
        {
          text: secret,
          usage: { inputTokens: 100, outputTokens: 200, finishReason: 'stop' },
          issues: [{ path: 'claims', message: 'Too many claims' }],
        },
        { cause: null },
      );

      await expect(
        generateStructured(
          {
            roleName: 'adjudication',
            role: resolveInternalModelProfile().roles.adjudication,
            schema: z.object({ valid: z.boolean() }),
            prompt: 'Synthetic fixture',
            accounting: createMemoryModelAccounting({
              maxUsd: 10,
              maxTokens: 100_000,
              deadlineAt: '2099-01-01T00:00:00.000Z',
            }),
          },
          () => Promise.reject(error),
        ),
      ).rejects.toBe(error);
      expect(String(warning.mock.calls[0]?.[0]).includes(secret)).toBe(
        setting === '1',
      );
      expect(String(warning.mock.calls[0]?.[0])).toContain(
        'classification=schema',
      );
    },
  );

  it.each([
    {
      error: new DOMException(secret, 'TimeoutError'),
      classification: 'timeout',
      errorClass: 'TimeoutError',
      httpStatus: undefined,
    },
    {
      error: new DOMException(secret, 'AbortError'),
      classification: 'abort',
      errorClass: 'AbortError',
      httpStatus: undefined,
    },
    {
      error: createProviderError(429),
      classification: 'provider',
      errorClass: 'AI_APICallError',
      httpStatus: 429,
    },
    {
      error: createProviderError(504),
      classification: 'timeout',
      errorClass: 'AI_APICallError',
      httpStatus: 504,
    },
    {
      error: createSchemaError(),
      classification: 'schema',
      errorClass: 'AI_NoObjectGeneratedError',
      httpStatus: undefined,
    },
    {
      error: createSchemaError('length'),
      classification: 'outputlimit',
      errorClass: 'AI_NoObjectGeneratedError',
      httpStatus: undefined,
    },
    {
      error: new TypeError(secret),
      classification: 'unclassified',
      errorClass: 'TypeError',
      httpStatus: undefined,
    },
  ] as const)(
    'should classify a known error without revealing any payload',
    ({ error, classification, errorClass, httpStatus }) => {
      const diagnostic = structuredFailureDiagnostic(error);

      expect(diagnostic).toEqual({
        classification,
        errorClass,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
    },
  );

  it('should use bounded nested transport status/codes and abort signals without logging causes', () => {
    const nested = new Error(secret, { cause: createProviderError(503) });

    expect(structuredFailureDiagnostic(nested)).toEqual({
      classification: 'provider',
      errorClass: 'Error',
      httpStatus: 503,
    });

    const timeout = new TypeError(secret, {
      cause: { code: 'UND_ERR_HEADERS_TIMEOUT', responseBody: secret },
    });

    expect(structuredFailureDiagnostic(timeout).classification).toBe('timeout');
    expect(
      structuredFailureDiagnostic(
        new Error(secret),
        AbortSignal.abort(new Error(secret)),
      ).classification,
    ).toBe('abort');
    expect(
      structuredFailureDiagnostic(
        new Error(secret),
        AbortSignal.abort(new DOMException(secret, 'TimeoutError')),
      ).classification,
    ).toBe('timeout');

    const cyclic = new Error(secret, { cause: null });
    cyclic.cause = cyclic;

    expect(structuredFailureDiagnostic(cyclic)).toEqual({
      classification: 'unclassified',
      errorClass: 'Error',
    });
  });

  it('should omit arbitrary class names, string/out-of-range status, secret getters and non-error payloads', () => {
    const custom = Object.assign(new Error(secret), {
      name: secret,
      statusCode: secret,
      headers: { authorization: secret },
    });

    expect(structuredFailureDiagnostic(custom)).toEqual({
      classification: 'unclassified',
      errorClass: 'Error',
    });
    expect(
      structuredFailureDiagnostic({
        name: secret,
        statusCode: 123456,
        body: secret,
      }),
    ).toEqual({ classification: 'unclassified', errorClass: 'NonError' });

    const hostile = Object.defineProperty(new Error(secret), 'name', {
      get: () => {
        throw new Error(secret);
      },
    });

    expect(structuredFailureDiagnostic(hostile)).toEqual({
      classification: 'unclassified',
      errorClass: 'Error',
    });
    expect(structuredFailureDiagnostic(secret)).toEqual({
      classification: 'unclassified',
      errorClass: 'NonError',
    });
  });

  it('should log only safe call correlation fields and rethrows the identical provider error without releasing its reservation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const accounting = createMemoryModelAccounting({
      maxUsd: 10,
      maxTokens: 100_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });

    const error = createProviderError(504);
    const transport: StructuredTransport = () => {
      return Promise.reject(error);
    };

    await expect(
      generateStructured(
        {
          roleName: 'premiseVerifier',
          role: resolveInternalModelProfile('opus-grounding-v1').roles
            .premiseVerifier,
          schema: z.object({ valid: z.boolean() }),
          prompt: secret,
          system: secret,
          accounting,
        },
        transport,
      ),
    ).rejects.toBe(error);
    expect(warning).toHaveBeenCalledTimes(1);

    const line = String(warning.mock.calls[0]?.[0]);
    const [callId = ''] = Object.keys(accounting.state.calls);

    expect(line).toContain('Model request failed');
    expect(line).toContain(`callId=${callId}`);
    expect(line).toContain('role=premiseVerifier');
    expect(line).toContain('model=anthropic/claude-opus-4.6');
    expect(line).toMatch(/durationMs=\d+/);
    expect(line).toContain('classification=timeout');
    expect(line).toContain('errorClass=AI_APICallError');
    expect(line).toContain('httpStatus=504');
    expect(line).not.toContain(secret);
    expect(line).not.toContain('https://');
    expect(line).not.toContain('authorization');
    expect(accounting.state.calls[callId]?.usage).toBeUndefined();
  });

  it('should retain the existing schema-error usage settlement while emitting a sanitized diagnostic', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const accounting = createMemoryModelAccounting({
      maxUsd: 10,
      maxTokens: 100_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });

    const error = createSchemaError();
    const transport: StructuredTransport = () => {
      return Promise.reject(error);
    };

    await expect(
      generateStructured(
        {
          roleName: 'adjudication',
          role: resolveInternalModelProfile().roles.adjudication,
          schema: z.object({ valid: z.boolean() }),
          prompt: secret,
          accounting,
        },
        transport,
      ),
    ).rejects.toBe(error);
    expect(Object.values(accounting.state.calls)[0]?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 200,
      finishReason: 'stop',
    });
    expect(warning.mock.calls[0]?.[0]).toContain('classification=schema');
    expect(warning.mock.calls[0]?.[0]).not.toContain(secret);
  });
});
