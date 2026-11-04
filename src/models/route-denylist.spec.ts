import { describe, expect, it } from 'vitest';
import { dispatchProviderOptions } from './structured';
import { resolveInternalModelProfile } from './profiles';

describe('structured - dispatchProviderOptions()', () => {
  const pinned = resolveInternalModelProfile('deepseek-harness-v1', {}).roles
    .premiseVerifier.providerOptions;

  it('should remove denied routes from a pinned allowlist without touching the pin', () => {
    expect(dispatchProviderOptions(pinned, 'fireworks').gateway?.only).toEqual([
      'deepseek',
    ]);
    expect(pinned.gateway?.only).toEqual(['deepseek', 'fireworks']);
  });

  it('should ignore a denylist that names no pinned route or would empty the list', () => {
    expect(dispatchProviderOptions(pinned, 'deepinfra, baseten')).toBe(pinned);
    expect(dispatchProviderOptions(pinned, 'deepseek,fireworks')).toBe(pinned);
    expect(dispatchProviderOptions(pinned, '')).toBe(pinned);
  });

  it('should leave options without an allowlist alone', () => {
    const astra = resolveInternalModelProfile('astra-harness-v1', {}).roles
      .premiseVerifier.providerOptions;

    expect(dispatchProviderOptions(astra, 'deepinfra')).toBe(astra);
  });
});
