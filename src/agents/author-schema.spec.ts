import { describe, expect, it } from 'vitest';
import configFixture from '../__fixtures__/replay/literally-2026-q3/config.json';
import { authorOutputSchema } from './author-schema';

// Depth decides what a run costs, so the operator sets it in audit.json and
// the author's proposal never does.
const proposal = () => {
  return authorOutputSchema.strip().parse(configFixture);
};

describe('author-schema - authorOutputSchema', () => {
  it('should refuse a chat depth in the proposal', () => {
    const result = authorOutputSchema.safeParse({
      ...proposal(),
      chatProbes: { runsPerPrompt: 12 },
    });

    expect(result.success).toBe(false);
  });

  it('should keep the proposed agent depth at 1 or 2 runs per prompt', () => {
    const deeper = authorOutputSchema.safeParse({
      ...proposal(),
      agentProbes: { runsPerPrompt: 3 },
    });
    const standard = authorOutputSchema.safeParse({
      ...proposal(),
      agentProbes: { runsPerPrompt: 2 },
    });

    expect(deeper.success).toBe(false);
    expect(standard.success).toBe(true);
  });
});
