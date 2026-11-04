import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  agentProbeRetryPolicy,
  probeFailureKinds,
  probeRetryPolicy,
  ProbeFailure,
  classifyGatewayError,
  classifyProbeError,
  retryDelayMs,
} from './failure';

// ============================================================================
// One retry policy table for every probe runner (hardening spec §4.6).
// ============================================================================

describe('failure - retryDelayMs()', () => {
  it('should follow the capacity ladder and stop after the last rung', () => {
    expect(retryDelayMs('capacity', 1)).toBe(60_000);
    expect(retryDelayMs('capacity', 2)).toBe(180_000);
    expect(retryDelayMs('capacity', 3)).toBeNull();
  });

  it('should retry ordinary, timeout, parser and empty-answer failures once', () => {
    for (const kind of [
      'cli_error',
      'timeout',
      'parser',
      'empty_answer',
    ] as const) {
      expect(retryDelayMs(kind, 1), kind).toBe(5_000);
      expect(retryDelayMs(kind, 2), kind).toBeNull();
    }
  });

  it('should never retry auth, rejected web tools, or persistence failures', () => {
    for (const kind of ['auth', 'rejected_web_tool', 'persistence'] as const) {
      expect(retryDelayMs(kind, 1), kind).toBeNull();
    }
  });

  it('should back agent CLI capacity failures off exponentially for six attempts', () => {
    const delaysMs = [1, 2, 3, 4, 5, 6].map((attempt) =>
      retryDelayMs('capacity', attempt, agentProbeRetryPolicy),
    );

    expect(delaysMs).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      960_000,
      null,
    ]);
  });

  it('should keep the shared table for every other agent CLI failure kind', () => {
    const otherKinds = probeFailureKinds.filter((kind) => kind !== 'capacity');

    const agentRules = otherKinds.map((kind) => agentProbeRetryPolicy[kind]);

    expect(agentRules).toEqual(
      otherKinds.map((kind) => probeRetryPolicy[kind]),
    );
  });

  it('should have a policy for every kind', () => {
    for (const kind of probeFailureKinds) {
      expect(probeRetryPolicy[kind].maxAttempts).toBeGreaterThanOrEqual(1);
    }
  });
});

const apiError = (statusCode: number): APICallError => {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://gateway.example',
    requestBodyValues: {},
    statusCode,
  });
};

describe('failure - classifyGatewayError()', () => {
  it('should map gateway status codes to kinds', () => {
    expect(classifyGatewayError(apiError(401))).toBe('auth');
    expect(classifyGatewayError(apiError(403))).toBe('auth');
    expect(classifyGatewayError(apiError(408))).toBe('timeout');
    expect(classifyGatewayError(apiError(429))).toBe('capacity');
    expect(classifyGatewayError(apiError(503))).toBe('capacity');
    expect(classifyGatewayError(apiError(529))).toBe('capacity');
    expect(classifyGatewayError(apiError(500))).toBe('cli_error');
    expect(classifyGatewayError(apiError(400))).toBe('cli_error');
  });

  it('should keep a typed failure and read abort signals as timeouts', () => {
    expect(
      classifyGatewayError(new ProbeFailure('empty_answer', 'no text')),
    ).toBe('empty_answer');

    const aborted = new Error('The operation was aborted');
    aborted.name = 'TimeoutError';
    expect(classifyGatewayError(aborted)).toBe('timeout');
  });

  it('should fall back to message classification', () => {
    expect(classifyProbeError(new Error('Overloaded'))).toBe('capacity');
    expect(classifyProbeError(new Error('invalid api key'))).toBe('auth');
    expect(classifyProbeError(new Error('boom'))).toBe('cli_error');
  });
});
