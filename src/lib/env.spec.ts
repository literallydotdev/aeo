import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertEnvVars } from './env';

describe('env - assertEnvVars()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should pass silently when every required var is set', () => {
    vi.stubEnv('AEO_TEST_VAR_A', 'set');

    expect(() =>
      assertEnvVars([{ name: 'AEO_TEST_VAR_A', purpose: 'testing' }]),
    ).not.toThrow();
  });

  it('should throw one error listing every missing var, not just the first', () => {
    vi.stubEnv('AEO_TEST_VAR_A', 'set');

    expect(() =>
      assertEnvVars([
        { name: 'AEO_TEST_VAR_A', purpose: 'is set' },
        { name: 'AEO_TEST_VAR_B', purpose: 'first missing' },
        { name: 'AEO_TEST_VAR_C', purpose: 'second missing' },
      ]),
    ).toThrow(/AEO_TEST_VAR_B[\s\S]*AEO_TEST_VAR_C/);
  });

  it('should treat an empty string as missing', () => {
    vi.stubEnv('AEO_TEST_VAR_A', '');

    expect(() =>
      assertEnvVars([{ name: 'AEO_TEST_VAR_A', purpose: 'testing' }]),
    ).toThrow(/AEO_TEST_VAR_A/);
  });
});
