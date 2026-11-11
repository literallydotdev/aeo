import { describe, expect, it } from 'vitest';
import { syntheticExample } from './author/examples';
import { planRun, RunRequestError } from './runner';
import {
  agentSurfaces,
  chatSurfaces,
  defaultSurfaces,
  aeoAuditConfigSchema,
  runRequestSchema,
} from './schema';

// ============================================================================
// Surface selection (specs/aeo-surface-selection-spec.md §5): the config's
// coding-agent decision, its default, and how the plan follows it. The
// consumer apps (method release spec §5.4) are measured only when a config
// lists them.
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

  it('should take the consumer apps a config lists, each once, and keep a config without them as it was', () => {
    const decision = {
      codingAgents: 'skip',
      because: 'Buyers are restaurant owners.',
    };
    const withApps = (consumerApps: unknown) => {
      return aeoAuditConfigSchema.safeParse({
        ...base,
        surfaces: { ...decision, consumerApps },
      });
    };

    expect(withApps(['google_ai_mode', 'chatgpt_app']).data?.surfaces).toEqual({
      ...decision,
      consumerApps: ['google_ai_mode', 'chatgpt_app'],
    });
    expect(withApps([]).success).toBe(false);
    expect(withApps(['chatgpt']).success).toBe(false);
    expect(withApps(['chatgpt_app', 'chatgpt_app']).success).toBe(false);
    expect(
      aeoAuditConfigSchema.parse({ ...base, surfaces: decision }).surfaces,
    ).toEqual(decision);
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
    expect(measure.surfaces).toEqual(defaultSurfaces);
    expect(measure.units).toHaveLength(90);
  });

  it('should plan a consumer app only for a config that lists it, asked once per question after the default surfaces', () => {
    const listed = aeoAuditConfigSchema.parse({
      ...base,
      surfaces: {
        codingAgents: 'skip',
        because: 'Buyers are restaurant owners.',
        consumerApps: ['google_ai_mode', 'chatgpt_app'],
      },
    });

    const plan = planRun(listed, request());

    expect(plan.surfaces).toEqual([
      ...chatSurfaces,
      'google_ai_mode',
      'chatgpt_app',
    ]);
    expect(plan.probesBySurface.get('chatgpt_app')).toBe(6);
    expect(plan.probesBySurface.get('google_ai_mode')).toBe(6);
    // The 54 chat units, and one per question on each consumer app.
    expect(plan.units).toHaveLength(66);
    expect(plan.agentSurfaces).toEqual([]);
  });

  it('should refuse to plan a consumer app in a market DataForSEO cannot place, naming it', () => {
    const unmapped = aeoAuditConfigSchema.parse({
      ...base,
      geography: 'global',
      language: 'en',
    });

    expect(() =>
      planRun(unmapped, request(['chatgpt', 'chatgpt_app'])),
    ).toThrow(/chatgpt_app cannot be placed there/);
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
