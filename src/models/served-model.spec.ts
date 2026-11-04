import { describe, expect, it } from 'vitest';
import { servedModelOf } from './served-model';

describe('served-model - servedModelOf()', () => {
  it('should record the upstream route the provider named', () => {
    const served = servedModelOf(
      'provider/open-model',
      'accounts/upstream/models/open-model-v1',
    );

    expect(served).toBe('accounts/upstream/models/open-model-v1');
  });

  it('should NOT record the SDK echoing the requested model as an observation', () => {
    const served = servedModelOf('openai/gpt-5', 'openai/gpt-5');

    expect(served).toBeUndefined();
  });

  it('should record nothing when the response names no model', () => {
    expect(servedModelOf('openai/gpt-5', undefined)).toBeUndefined();
    expect(servedModelOf('openai/gpt-5', '')).toBeUndefined();
  });
});
