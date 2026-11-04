import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { researchActionSchema } from '../grounding/tools';
import { proposedAssessmentSchema } from '../grounding/model';
import { aeoAgentCopyDraftSchema } from '../agents/copy-schema';
import {
  authorOutputSchema,
  authorNotesSchema,
} from '../agents/author-validation';
import { structuredWireSchema } from './wire-schema';

const assertStrictShape = (value: unknown) => {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    return value.forEach(assertStrictShape);
  }

  const schema = value as Record<string, unknown>;

  expect(schema).not.toHaveProperty('oneOf');

  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties ?? {}));
  }

  Object.values(schema).forEach(assertStrictShape);
};

describe('wire-schema - structuredWireSchema()', () => {
  it('should preserve explicit nullable values and decode nullable or union record branches', () => {
    const optional = structuredWireSchema(
      z.object({ value: z.string().nullable().optional() }).strict(),
    );

    expect(optional.decode({ value: null })).toEqual({ value: null });

    const nullable = structuredWireSchema(
      z.record(z.string(), z.string()).nullable(),
    );

    expect(
      nullable.decode({ result: [{ key: 'name', value: 'Deno' }] }),
    ).toEqual({ name: 'Deno' });
    expect(nullable.decode({ result: null })).toBeNull();

    const union = structuredWireSchema(
      z.union([
        z.object({ plain: z.string() }).strict(),
        z.object({ entries: z.record(z.string(), z.string()) }).strict(),
      ]),
    );

    expect(
      union.decode({ result: { entries: [{ key: 'name', value: 'Deno' }] } }),
    ).toEqual({ entries: { name: 'Deno' } });
  });

  it('should support real research, adjudication, author and nested copy schemas', () => {
    const schemas: z.ZodType[] = [
      researchActionSchema,
      z.object({ assessments: z.array(proposedAssessmentSchema) }),
      aeoAgentCopyDraftSchema,
      z.object({ output: authorOutputSchema, notes: authorNotesSchema }),
    ];

    for (const schema of schemas) {
      const wire = structuredWireSchema(schema);

      expect(wire.wire.type).toBe('object');
      expect(wire.wire).not.toHaveProperty('anyOf');

      assertStrictShape(wire.wire);
    }
  });

  it('should unwrap research actions but preserve original branch constraints', () => {
    const wire = structuredWireSchema(researchActionSchema);
    const action = {
      tool: 'fetch_source',
      candidateIds: ['c1'],
      relevance: 'Resolve generation scope',
      url: 'https://docs.deno.com/deploy/',
    };

    expect(wire.decode({ result: action })).toEqual(action);
    expect(() => wire.decode(action)).toThrow();
    expect(() =>
      wire.decode({
        result: JSON.parse(
          `${JSON.stringify(action).slice(0, -1)},"__proto__":null}`,
        ) as unknown,
      }),
    ).toThrow('union shape');
    expect(() =>
      wire.decode({ result: { ...action, url: 'invalid' } }),
    ).toThrow();
  });

  it('should decode dynamic section keys and optional fields without relaxing host validation', () => {
    const wire = structuredWireSchema(aeoAgentCopyDraftSchema);
    const fact = { kind: 'fact', factId: 'fact-1' };
    const input = {
      intro: [fact],
      sections: [
        {
          key: 'tools',
          value: {
            subtitle: [fact],
            perceptionCopy: null,
            retrievalCopy: null,
          },
        },
      ],
      actionPlan: null,
      confidence: 0.9,
    };

    expect(wire.decode(input)).toEqual({
      intro: [fact],
      sections: { tools: { subtitle: [fact] } },
      confidence: 0.9,
    });
    expect(() =>
      wire.decode({
        ...input,
        sections: [...input.sections, ...input.sections],
      }),
    ).toThrow('duplicate');
    expect(() => wire.decode({ ...input, invented: null })).toThrow();

    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(() =>
        wire.decode(
          JSON.parse(`${JSON.stringify(input).slice(0, -1)},"${name}":null}`),
        ),
      ).toThrow();
    }

    expect(() =>
      wire.decode({
        ...input,
        intro: [{ kind: 'recommendation', text: 'Correct the error' }],
      }),
    ).toThrow();
  });

  it('should report why a response the wire contract allowed was still refused', async () => {
    const schema = z
      .object({
        text: z
          .string()
          .max(1200)
          .refine(
            (value) => value.trim().split(/\s+/).length <= 3,
            'The introduction must fit in 3 words',
          )
          .describe('Plain prose, at most 3 words.'),
      })
      .strict();
    const wire = structuredWireSchema(schema);
    const published = JSON.stringify(wire.wire);
    // The rule cannot be published as a constraint, only described.

    expect(published).toContain('at most 3 words');
    expect(published).toContain('"maxLength":1200');
    expect(wire.lastFailure()).toEqual([]);

    const refused = await wire.sdkSchema.validate?.({
      text: 'one two three four',
    });

    expect(refused?.success).toBe(false);
    expect(wire.lastFailure()).toEqual([
      { path: 'text', message: 'The introduction must fit in 3 words' },
    ]);

    const accepted = await wire.sdkSchema.validate?.({ text: 'one two three' });

    expect(accepted?.success).toBe(true);
    expect(wire.lastFailure()).toEqual([]);
  });
});
