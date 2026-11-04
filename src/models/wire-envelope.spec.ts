import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { structuredWireSchema } from './wire-schema';

// A union schema travels in a `{ result }` envelope. Opus 5 through the
// gateway sometimes returns that envelope as a JSON string under `input`
// (captured 2026-09-12 from an evidence-review turn); the answer inside is
// legal and must decode. Any other wrong envelope is still refused.

const turn = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('tool:read_artifact'),
      input: z.object({ itemId: z.string() }),
    })
    .strict(),
  z.object({ action: z.literal('finish') }).strict(),
]);

describe('wire-schema - structuredWireSchema() envelope', () => {
  const wire = structuredWireSchema(turn);

  it('should wrap a union and decode the plain envelope', () => {
    expect(wire.wrapped).toBe(true);
    expect(wire.decode({ result: { action: 'finish' } })).toEqual({
      action: 'finish',
    });
  });

  it('should unwrap the double-encoded envelope Opus 5 returned', () => {
    const captured = {
      input: JSON.stringify({
        result: {
          action: 'tool:read_artifact',
          input: { itemId: 'rows:typescript_api_hosting:2' },
        },
      }),
    };

    expect(wire.decode(captured)).toEqual({
      action: 'tool:read_artifact',
      input: { itemId: 'rows:typescript_api_hosting:2' },
    });
  });

  it('should unwrap the nested envelope Opus 5 returned', () => {
    expect(wire.decode({ result: { result: { action: 'finish' } } })).toEqual({
      action: 'finish',
    });
    expect(() =>
      wire.decode({ result: { result: { action: 'nope' } } }),
    ).toThrow();
    expect(() =>
      wire.decode({ result: { result: { result: { action: 'finish' } } } }),
    ).toThrow();
  });

  it('should still refuse any other wrong envelope', () => {
    expect(() => wire.decode({ action: 'finish' })).toThrow('envelope');
    expect(() => wire.decode({ input: 'not json' })).toThrow('envelope');
    expect(() =>
      wire.decode({ input: JSON.stringify({ action: 'finish' }) }),
    ).toThrow('envelope');
    expect(() => wire.decode({ input: '{}', extra: 1 })).toThrow('envelope');
  });
});
