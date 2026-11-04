import { describe, expect, it } from 'vitest';
import type { InternalModelRoleConfig } from './profiles';
import { dispatchProviderOptions } from './structured';
import { testModelProfileFixture } from './profile-fixture';

describe('structured - dispatchProviderOptions()', () => {
  const pinned: InternalModelRoleConfig['providerOptions'] = {
    gateway: {
      reasoning: { effort: 'high' },
      only: ['first-route', 'second-route'],
    },
  };

  it('should remove denied routes from a pinned allowlist without touching the pin', () => {
    expect(
      dispatchProviderOptions(pinned, 'second-route').gateway?.only,
    ).toEqual(['first-route']);
    expect(pinned.gateway?.only).toEqual(['first-route', 'second-route']);
  });

  it('should ignore a denylist that names no pinned route or would empty the list', () => {
    expect(dispatchProviderOptions(pinned, 'third-route, fourth-route')).toBe(
      pinned,
    );
    expect(dispatchProviderOptions(pinned, 'first-route,second-route')).toBe(
      pinned,
    );
    expect(dispatchProviderOptions(pinned, '')).toBe(pinned);
  });

  it('should leave options without an allowlist alone', () => {
    const unrouted =
      testModelProfileFixture().roles.premiseVerifier.providerOptions;

    expect(dispatchProviderOptions(unrouted, 'first-route')).toBe(unrouted);
  });
});
