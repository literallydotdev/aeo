import { describe, expect, it } from 'vitest';
import { createMemoryModelAccounting } from '../models/accounting';
import { resolveInternalModelProfile } from '../models/profiles';
import type { StructuredTransport } from '../models/structured';
import { contentHash } from '../stores/content-hash';
import { requireDefined } from '../__fixtures__/require-defined';
import {
  buildCandidateInventory,
  extractClaimCandidates,
  type ValidatedExtractionBatch,
} from './extract';
import type { SavedAnswer } from './schema';

const capturedAt = '2026-09-09T10:15:30.000Z';
const date = '2026-07-20T00:00:00.000Z';

const answer = (
  text: string,
  capture: string | null = capturedAt,
): SavedAnswer => {
  return {
    id: 'answer-1',
    runId: 'run-1',
    section: 'hosting',
    promptId: 'p1',
    surface: 'chatgpt',
    runIndex: 0,
    capturedAt: capture,
    text,
    digest: contentHash(text),
  };
};

const claim = (
  quote: string,
  applicableAt: string | null,
  proposition = quote,
) => {
  return {
    answerId: 'answer-1',
    proposition,
    quote,
    scope: {
      product: 'Deno Deploy',
      generation: 'Classic',
      version: '1',
      applicableAt,
    },
    category: 'lifecycle' as const,
    inAuditedProductScope: true,
  };
};

describe('extract - buildCandidateInventory()', () => {
  it.each([
    [
      'month-only first day',
      'Classic was retired in July 2026.',
      '2026-07-01T00:00:00.000Z',
      null,
    ],
    [
      'month-only last day',
      'Classic was retired in July 2026.',
      '2026-07-31T00:00:00.000Z',
      null,
    ],
    [
      'year-only first day',
      'Classic was retired in 2026.',
      '2026-01-01T00:00:00.000Z',
      null,
    ],
    [
      'year-only last day',
      'Classic was retired in 2026.',
      '2026-12-31T00:00:00.000Z',
      null,
    ],
    ['no date', 'Classic was retired.', date, null],
    ['relative date', 'Classic was retired last month.', date, null],
    ['missing year', 'Classic was retired on July 20.', date, null],
    ['different day', 'Classic was retired on July 21, 2026.', date, null],
    [
      'embedded ISO-like number',
      'Release 12026-07-20 is deprecated.',
      date,
      null,
    ],
    ['ISO day', 'Classic was retired on 2026-07-20.', date, date],
    [
      'ISO timestamp',
      'Classic was retired on 2026-07-20T16:00:00Z.',
      date,
      date,
    ],
    [
      'English month first',
      'Classic was retired on July 20, 2026.',
      date,
      date,
    ],
    [
      'English without comma',
      'Classic was retired on July 20 2026.',
      date,
      date,
    ],
    ['English day first', 'Classic was retired on 20 July 2026.', date, date],
    [
      'English ordinal',
      'Classic was retired on the 20th of July, 2026.',
      date,
      date,
    ],
    [
      'English abbreviated month',
      'Classic was retired on Jul. 20, 2026.',
      date,
      date,
    ],
    ['case insensitive', 'Classic was retired on 20 JULY 2026.', date, date],
    ['null stays null', 'Classic was retired on July 20, 2026.', null, null],
    ['capture instant', 'Classic is deprecated.', capturedAt, capturedAt],
    [
      'equivalent capture instant',
      'Classic is deprecated.',
      '2026-09-09T10:15:30+00:00',
      '2026-09-09T10:15:30+00:00',
    ],
    [
      'capture date with invented time',
      'Classic is deprecated.',
      '2026-09-09T00:00:00.000Z',
      null,
    ],
  ] as const)(
    'should handle %s without inventing precision',
    (...[, quote, proposed, expected]) => {
      const raw = claim(quote, proposed);
      const before = structuredClone(raw);

      const [candidate] = buildCandidateInventory([raw], [answer(quote)]);

      const inventoried = requireDefined(candidate, 'candidate');

      expect(inventoried.scope).toEqual({
        ...raw.scope,
        applicableAt: expected,
      });
      expect(inventoried.proposition).toBe(quote);
      expect(inventoried.occurrences[0]?.quote).toBe(quote);
      expect(raw).toEqual(before);
    },
  );

  it('should require the complete day in the quoted span rather than the surrounding answer or proposition', () => {
    const quote = 'Classic was retired in July 2026.';
    const raw = claim(quote, date, 'Classic was retired on July 20, 2026.');

    const [candidate] = buildCandidateInventory(
      [raw],
      [answer(`A different product launched July 20, 2026. ${quote}`)],
    );

    expect(candidate?.scope.applicableAt).toBeNull();
    expect(candidate?.proposition).toBe(raw.proposition);
  });

  it('should keep an explicit date without a capture timestamp and clear an unsupported one', () => {
    const quote = 'Classic was retired on July 20, 2026.';

    const [dated] = buildCandidateInventory(
      [claim(quote, date)],
      [answer(quote, null)],
    );
    const [undated] = buildCandidateInventory(
      [claim('Classic was retired.', capturedAt)],
      [answer('Classic was retired.', null)],
    );

    expect(requireDefined(dated, 'dated').scope.applicableAt).toBe(date);
    expect(requireDefined(undated, 'undated').scope.applicableAt).toBeNull();
  });

  it('should derive stable candidate identities after clearing invented precision', () => {
    const quote = 'Classic was retired in July 2026.';
    const raw = [
      claim(quote, '2026-07-01T00:00:00.000Z'),
      claim(quote, '2026-07-31T00:00:00.000Z'),
    ];

    const candidates = buildCandidateInventory(raw, [answer(quote)]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      buildCandidateInventory([claim(quote, null)], [answer(quote)])[0],
    );
  });
});

describe('extract - extractClaimCandidates()', () => {
  it('should rebuild normalized candidates from the unchanged raw batch cache without another model call', async () => {
    const quote = 'Classic was retired in July 2026.';
    const raw = claim(quote, '2026-07-01T00:00:00.000Z');
    const entries = new Map<string, ValidatedExtractionBatch>();
    let calls = 0;
    const transport: StructuredTransport = (input) => {
      calls += 1;

      return Promise.resolve({
        output: input.schema.parse({ claims: [raw] }),
        usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 },
      });
    };
    const args = {
      answers: [answer(quote)],
      product: 'Deno Deploy',
      role: resolveInternalModelProfile().roles.perception,
      accounting: createMemoryModelAccounting({
        maxUsd: 10,
        maxTokens: 1_000_000,
        deadlineAt: '2099-01-01T00:00:00.000Z',
      }),
      transport,
      batchCache: {
        get: (key: string) => Promise.resolve(entries.get(key)),
        put: (key: string, value: ValidatedExtractionBatch) => {
          entries.set(key, value);

          return Promise.resolve();
        },
      },
    };

    const fresh = await extractClaimCandidates(args);
    const cached = await extractClaimCandidates(args);

    expect(cached).toEqual(fresh);
    expect(cached.candidates[0]?.scope.applicableAt).toBeNull();
    expect(calls).toBe(1);
    expect([...entries.values()][0]?.output.claims).toEqual([raw]);
    expect(raw.scope.applicableAt).toBe('2026-07-01T00:00:00.000Z');
  });
});
