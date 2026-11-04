import { assert, describe, expect, it } from 'vitest';
import { createMemoryModelAccounting } from '../models/accounting';
import { testModelProfileFixture } from '../models/profile-fixture';
import type { InternalModelContext } from '../models/context';
import type { StructuredTransport } from '../models/structured';
import type { AeoVisibility } from '../schema';
import { extractPerceptionForSection } from './sentiment';

const context = (transport: StructuredTransport): InternalModelContext => {
  return {
    profile: testModelProfileFixture(),
    accounting: createMemoryModelAccounting({
      maxUsd: 100,
      maxTokens: 10_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    }),
    transport,
  };
};

describe('sentiment - extractPerceptionForSection()', () => {
  it('should NOT turn an omitted brief fact into a suspected error', async () => {
    const internalModels = context((input) =>
      Promise.resolve({
        output: input.schema.parse({
          results: [
            {
              answerIndex: 0,
              narrativePhrases: ['Deploy Classic'],
              suspectedErrors: [
                {
                  claim: 'A retirement was announced.',
                  reason: 'The brief omitted it.',
                },
              ],
            },
          ],
        }),
        usage: {},
      }),
    );

    const result = await extractPerceptionForSection({
      sectionKey: 'tools',
      brandName: 'Deploy',
      productBrief: 'Incomplete summary',
      visibility: { matrix: [] } as unknown as AeoVisibility,
      answers: [
        {
          promptIdx: 0,
          surface: 'chatgpt',
          runIndex: 0,
          responseText: 'Deploy Classic has an announced retirement date.',
        },
      ],
      internalModels,
    });

    const [narrative] = result.section.narratives;

    assert(narrative);
    expect(result.section.flaggedClaims).toEqual([]);
    expect(narrative.phrase).toBe('Deploy Classic');
  });

  it('should block fabricated narrative quotations in the grounded path', async () => {
    const internalModels = context((input) =>
      Promise.resolve({
        output: input.schema.parse({
          results: [
            {
              answerIndex: 0,
              narrativePhrases: ['fabricated quotation'],
              suspectedErrors: [],
            },
          ],
        }),
        usage: {},
      }),
    );

    const result = await extractPerceptionForSection({
      sectionKey: 'tools',
      brandName: 'Deploy',
      productBrief: 'Incomplete summary',
      visibility: { matrix: [] } as unknown as AeoVisibility,
      answers: [
        {
          promptIdx: 0,
          surface: 'chatgpt',
          runIndex: 0,
          responseText: 'The captured answer.',
        },
      ],
      internalModels,
    });

    expect(result.failures[0]?.blocking).toBe(true);
    expect(result.section.narratives).toEqual([]);
  });
});
