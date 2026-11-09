import { describe, expect, it } from 'vitest';
import { syntheticExample } from './author/examples';
import { planRun, RunRequestError } from './runner';
import {
  agentSurfaces,
  allSurfaces,
  chatSurfaces,
  aeoAuditConfigSchema,
  runRequestSchema,
} from './schema';

// ============================================================================
// Surface selection (specs/aeo-surface-selection-spec.md §5): the config's
// coding-agent decision, its default, and how the plan follows it.
// ============================================================================

const base = {
  ...syntheticExample,
  reportKey: 'example',
  slug: 'example-abcde',
};

describe('schema - aeoAuditConfigSchema surfaces', () => {
  it('should default a config without the field to measuring every surface', () => {
    const { surfaces: _surfaces, ...withoutField } = base;
    const config = aeoAuditConfigSchema.parse(withoutField);
    expect(config.surfaces.codingAgents).toBe('measure');
    expect(config.surfaces.because).toContain('Default');
  });

  it('should require a reason with the decision and refuse other keys', () => {
    expect(
      aeoAuditConfigSchema.safeParse({
        ...base,
        surfaces: { codingAgents: 'skip', because: 'short' },
      }).success,
    ).toBe(false);

    expect(
      aeoAuditConfigSchema.safeParse({
        ...base,
        surfaces: {
          codingAgents: 'skip',
          because: 'Buyers are restaurant owners.',
          extra: true,
        },
      }).success,
    ).toBe(false);

    expect(
      aeoAuditConfigSchema.parse({
        ...base,
        surfaces: {
          codingAgents: 'skip',
          because: 'Buyers are restaurant owners.',
        },
      }).surfaces.codingAgents,
    ).toBe('skip');
  });
});

describe('runner - planRun()', () => {
  const request = (surfaces?: readonly string[]) => {
    return runRequestSchema.parse({
      reportKey: 'example',
      runId: 'run1',
      maxPlannedUnits: 400,
      ...(surfaces ? { surfaces } : {}),
    });
  };

  it('should plan the chat surfaces only for a skip config, every surface for a measure config', () => {
    const skip = aeoAuditConfigSchema.parse({
      ...base,
      surfaces: {
        codingAgents: 'skip',
        because: 'Buyers are restaurant owners.',
      },
    });

    const plan = planRun(skip, request());
    expect(plan.surfaces).toEqual(chatSurfaces);
    expect(plan.agentSurfaces).toEqual([]);
    expect(
      plan.units.every(
        (unit) => !agentSurfaces.includes(unit.surface as never),
      ),
    ).toBe(true);

    // 6 prompts × 9 chat units.
    expect(plan.units).toHaveLength(54);
    const measure = planRun(aeoAuditConfigSchema.parse(base), request());
    expect(measure.surfaces).toEqual(allSurfaces);
    expect(measure.units).toHaveLength(90);
  });

  it("should keep the request's surfaces as the operator's override on a skip config", () => {
    const skip = aeoAuditConfigSchema.parse({
      ...base,
      surfaces: {
        codingAgents: 'skip',
        because: 'Buyers are restaurant owners.',
      },
    });

    const plan = planRun(skip, request(['codex']));
    expect(plan.surfaces).toEqual(['codex']);
    expect(plan.agentSurfaces).toEqual(['codex']);
  });

  it.each([
    ['global', 'en'],
    ['constructor', 'en'],
    ['us', '__proto__'],
  ])(
    'should refuse to plan AI Overviews in a market DataForSEO cannot place, naming the market: %s, %s',
    (geography, language) => {
      const unmapped = aeoAuditConfigSchema.parse({
        ...base,
        geography,
        language,
      });

      expect(() => planRun(unmapped, request())).toThrow(RunRequestError);
      expect(() => planRun(unmapped, request())).toThrow(
        `geography "${geography}" and language "${language}"`,
      );
    },
  );

  it('should plan an unmapped market when the run leaves AI Overviews out', () => {
    const unmapped = aeoAuditConfigSchema.parse({
      ...base,
      geography: 'global',
      language: 'en',
    });

    expect(planRun(unmapped, request(['chatgpt'])).surfaces).toEqual([
      'chatgpt',
    ]);
  });
});
