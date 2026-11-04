import { afterEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import type { AeoVisibility } from '../schema';
import { createMemoryModelAccounting } from '../models/accounting';
import { testModelProfileFixture } from '../models/profile-fixture';
import type { StructuredTransport } from '../models/structured';
import {
  perceptionVersion,
  extractPerceptionForSection,
  selectValidResults,
  type BrandMentionAnswer,
} from './sentiment';

// Perception batches are validated on answerIndex the same way the search
// analyzer is on responseIndex (spec §3.3): a result for an answer that was
// not asked about is dropped, never a narrative pinned on the wrong answer.

const result = (answerIndex: number) => {
  return { answerIndex, narrativePhrases: [], suspectedErrors: [] };
};

describe('sentiment - selectValidResults()', () => {
  it('should keep asked-about, unique indices in any order', () => {
    const { kept, rejected } = selectValidResults(
      [result(17), result(15), result(16)],
      [15, 16, 17],
    );

    expect(kept.map((entry) => entry.answerIndex)).toEqual([17, 15, 16]);
    expect(rejected).toEqual([]);
  });

  it('should keep a batch that skipped answers (an answer with nothing to report)', () => {
    const { kept } = selectValidResults([result(16)], [15, 16, 17]);

    expect(kept).toHaveLength(1);
  });

  it('should drop an index that was not asked about and keep its neighbours', () => {
    // One stray integer is the model's mistake about one answer, not grounds
    // to throw away the judgements it got right. A re-ask about answers 15
    // and 17 alone is asked about exactly those, not the range between.
    const { kept, rejected } = selectValidResults(
      [result(15), result(0), result(16), result(17)],
      [15, 17],
    );

    expect(kept.map((entry) => entry.answerIndex)).toEqual([15, 17]);
    expect(rejected).toEqual([
      'answerIndex 0 was not asked about',
      'answerIndex 16 was not asked about',
    ]);
  });

  it('should drop a duplicated index, keeping its first judgement', () => {
    const { kept, rejected } = selectValidResults(
      [result(15), result(15)],
      [15, 16, 17],
    );

    expect(kept).toHaveLength(1);
    expect(rejected).toEqual(['answerIndex 15 twice']);
  });
});

describe('perceptionVersion', () => {
  it('should be pinned at the narrative-only, grounded-analysis pass', () => {
    expect(perceptionVersion).toBe(3);
  });
});

describe('sentiment - extractPerceptionForSection()', () => {
  afterEach(() => vi.useRealTimers());

  const answers: BrandMentionAnswer[] = [
    {
      promptIdx: 0,
      surface: 'chatgpt',
      runIndex: 1,
      responseText:
        'For a TypeScript API, **Deno Deploy** is the *simplest* option; Vercel is Node-centric.',
    },
    {
      promptIdx: 1,
      surface: 'claude',
      runIndex: 1,
      responseText:
        'Deno Deploy runs TypeScript with no build step, which keeps deployments fast.',
    },
    {
      promptIdx: 2,
      surface: 'gemini',
      runIndex: 1,
      responseText: 'Deno Deploy is edge-first and cheap at low volume.',
    },
  ];
  /** What one call returns, by the answer number it was asked about: a
   * phrase list, `null` to skip that answer, or an error to throw. */
  type Step = Record<number, string[] | null> | Error;
  const run = (subject: BrandMentionAnswer[], script: Step[]) => {
    const calls: number[][] = [];
    const transport: StructuredTransport = (input) => {
      const asked = [...input.prompt.matchAll(/--- Answer (\d+) /g)].map(
        (match) => Number(match[1]),
      );
      const step = script[calls.length];

      calls.push(asked);

      if (step instanceof Error) {
        return Promise.reject(step);
      }

      const results = asked.flatMap((answerIndex) => {
        const phrases = step?.[answerIndex];

        return phrases === null
          ? []
          : [
              {
                answerIndex,
                narrativePhrases: phrases ?? [],
                suspectedErrors: [],
              },
            ];
      });

      return Promise.resolve({
        output: input.schema.parse({ results }),
        usage: { costUsd: 0.01, inputTokens: 10, outputTokens: 5 },
      });
    };

    const profile = testModelProfileFixture();
    const extraction = extractPerceptionForSection({
      sectionKey: 's1',
      brandName: 'Deno',
      productBrief: 'A TypeScript runtime.',
      visibility: { matrix: [] } as unknown as AeoVisibility,
      answers: subject,
      internalModels: {
        profile,
        // Room for the retained reservations of failed calls: a call that
        // fails at the transport keeps its unknown charge held.
        accounting: createMemoryModelAccounting({
          maxUsd: 50,
          maxTokens: 1_000_000,
          deadlineAt: '2099-01-01T00:00:00.000Z',
        }),
        transport,
      },
    });

    return { extraction, calls };
  };

  const phrases = (section: { narratives: Array<{ phrase: string }> }) => {
    return section.narratives.map((entry) => entry.phrase);
  };

  it('should store the answer’s own passage when the model dropped its markdown', async () => {
    const { extraction, calls } = run(answers.slice(0, 1), [
      { 0: ['Deno Deploy is the simplest option'] },
    ]);
    const { section, failures } = await extraction;

    expect(failures).toEqual([]);
    expect(phrases(section)).toEqual([
      '**Deno Deploy** is the *simplest* option',
    ]);
    expect(calls).toEqual([[0]]);
  });

  it('should re-ask only the answer that was paraphrased and keep every phrase that verified', async () => {
    const { extraction, calls } = run(answers.slice(0, 2), [
      // Answer 0 quoted one phrase right and one wrong; answer 1 is fine.
      {
        0: ['Deno Deploy is the simplest option', 'Deno Deploy is the easiest'],
        1: ['no build step'],
      },
      // The re-ask carries answer 0 alone and quotes correctly.
      { 0: ['Vercel is Node-centric'] },
    ]);
    const { section, failures } = await extraction;

    expect(calls).toEqual([[0, 1], [0]]);
    expect(failures).toEqual([]);
    // The verified phrase of the first pass survives beside the retry's.
    expect(phrases(section)).toEqual([
      '**Deno Deploy** is the *simplest* option',
      'Vercel is Node-centric',
      'no build step',
    ]);
  });

  it('should record a blocking failure once every round paraphrased, still keeping the verified phrases', async () => {
    const { extraction, calls } = run(answers.slice(0, 1), [
      { 0: ['Deno Deploy is the easiest choice', 'Vercel is Node-centric'] },
      { 0: ['Deno Deploy is the best choice'] },
      { 0: ['Vercel is not for TypeScript'] },
    ]);
    const { section, failures } = await extraction;

    expect(calls).toEqual([[0], [0], [0]]);
    expect(phrases(section)).toEqual(['Vercel is Node-centric']);
    expect(failures).toEqual([
      {
        message:
          'answers 0-0 of 1: 3 narrative phrase(s) were not exact passages from their captured answers and were dropped',
        blocking: true,
      },
    ]);
  });

  it('should ask again for the answers the model skipped and record the one it never judged', async () => {
    const { extraction, calls } = run(answers, [
      { 0: ['simplest option'], 1: null, 2: null },
      { 1: ['no build step'], 2: null },
      { 2: null },
    ]);
    const { section, failures } = await extraction;

    expect(calls).toEqual([[0, 1, 2], [1, 2], [2]]);
    expect(phrases(section)).toEqual(['*simplest* option', 'no build step']);
    // Visible, and non-blocking: perception is an enrichment.
    expect(failures).toEqual([
      { message: 'answer 2 of 3 not judged after 3 round(s)', blocking: false },
    ]);
  });

  it('should keep the judged answers when a later round fails at the transport', async () => {
    vi.useFakeTimers();

    const unavailable = () => {
      return new APICallError({
        message: 'Unavailable',
        url: 'https://example.invalid',
        requestBodyValues: {},
        statusCode: 503,
      });
    };
    const { extraction, calls } = run(answers.slice(0, 2), [
      { 0: ['simplest option'], 1: null },
      unavailable(),
      unavailable(),
      unavailable(),
    ]);
    await vi.runAllTimersAsync();
    const { section, failures } = await extraction;

    // Three transport attempts, each carrying the skipped answer alone.
    expect(calls).toEqual([[0, 1], [1], [1], [1]]);
    expect(phrases(section)).toEqual(['*simplest* option']);
    expect(failures).toEqual([
      { message: 'answer 1 of 2: Unavailable', blocking: false },
    ]);
  });
});
