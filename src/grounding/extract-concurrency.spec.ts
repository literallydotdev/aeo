import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryModelAccounting,
  ModelBudgetError,
  type ModelCallAccounting,
} from '../models/accounting';
import { testModelProfileFixture } from '../models/profile-fixture';
import type { StructuredTransport } from '../models/structured';
import { contentHash } from '../stores/content-hash';
import { requireDefined } from '../__fixtures__/require-defined';
import type { SavedAnswer } from './schema';
import {
  extractClaimCandidates,
  type ValidatedExtractionBatch,
} from './extract';

const role = testModelProfileFixture().roles.perception;
const deadlineAt = '2099-01-01T00:00:00.000Z';

const answers = (count: number): SavedAnswer[] => {
  return Array.from({ length: count }, (_, index) => {
    const text = `Deno claim ${index} has exact original punctuation.`;

    return {
      id: `answer-${index}`,
      runId: 'run-1',
      section: 'runtime',
      promptId: 'p1',
      surface: 'chatgpt',
      runIndex: index,
      capturedAt: '2026-09-09T00:00:00.000Z',
      text,
      digest: contentHash(text),
    };
  });
};

const claim = (id: string, quote: string, proposition = quote) => {
  return {
    answerId: id,
    quote,
    proposition,
    scope: {
      product: 'Deno',
      generation: null,
      version: null,
      applicableAt: null,
    },
    category: 'capability',
    inAuditedProductScope: true,
  };
};

type SuppliedAnswer = { id: string; text: string };

const suppliedAnswers = (prompt: string): SuppliedAnswer[] => {
  const parsed = JSON.parse(prompt) as { answers: SuppliedAnswer[] };

  return parsed.answers;
};

const firstSuppliedId = (prompt: string): string => {
  return requireDefined(suppliedAnswers(prompt)[0], 'first supplied answer').id;
};

const output = (prompt: string) => {
  const claims = suppliedAnswers(prompt).map((answer) =>
    claim(answer.id, answer.text),
  );

  return { claims };
};

const firstClaim = (prompt: string) => {
  return requireDefined(output(prompt).claims[0], 'first claim');
};

const ledger = () => {
  return createMemoryModelAccounting({
    maxUsd: 100,
    maxTokens: 10_000_000,
    deadlineAt,
  });
};

const cache = () => {
  const entries = new Map<string, ValidatedExtractionBatch>();

  return {
    entries,
    get: (key: string) => Promise.resolve(entries.get(key)),
    put: vi.fn((key: string, batch: ValidatedExtractionBatch) => {
      entries.set(key, batch);

      return Promise.resolve();
    }),
  };
};

const transport: StructuredTransport = (input) => {
  return Promise.resolve({
    output: input.schema.parse(output(input.prompt)),
    usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 },
  });
};

const fortyClaims: StructuredTransport = (input) => {
  const first = firstClaim(input.prompt);

  return Promise.resolve({
    output: input.schema.parse({
      claims: Array.from({ length: 40 }, (_, index) => ({
        ...first,
        proposition: `${first.proposition} Detail ${index}.`,
      })),
    }),
    usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 },
  });
};

const release = (releases: readonly (() => void)[], index: number) => {
  requireDefined(releases[index], `release ${index}`)();
};

type MemoryAccounting = ReturnType<typeof createMemoryModelAccounting>;

/**
 * createLazyLedger sizes a memory ledger from the first reservation it sees,
 * so a test can hold exactly one and a half admissions.
 */
const createLazyLedger = (
  size: (call: Parameters<ModelCallAccounting['reserve']>[0]) => {
    maxUsd: number;
    maxTokens: number;
  },
) => {
  let base: MemoryAccounting | undefined;
  let attempts = 0;

  const accounting: ModelCallAccounting = {
    deadlineAt,
    assertOwned: () => Promise.resolve(),
    reserve: async (call) => {
      attempts += 1;
      base ??= createMemoryModelAccounting({ ...size(call), deadlineAt });
      await base.reserve(call);
    },
    settle: async (id, usage) => {
      await requireDefined(base, 'ledger').settle(id, usage);
    },
  };

  return {
    accounting,
    getLedger: () => requireDefined(base, 'ledger'),
    getAttempts: () => attempts,
  };
};

describe('extract - extractClaimCandidates() concurrency', () => {
  it('should run at most four batches and produce the same inventory despite reverse completion order', async () => {
    const releases: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;
    const delayed: StructuredTransport = async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);

      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });

      active -= 1;

      return transport(input);
    };
    const progress = vi.fn();

    const run = extractClaimCandidates({
      answers: answers(15),
      product: 'Deno',
      role,
      accounting: ledger(),
      transport: delayed,
      onProgress: progress,
    });
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    release(releases, 3);
    release(releases, 2);
    release(releases, 1);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(3));

    expect(releases).toHaveLength(4);

    release(releases, 0);
    await vi.waitFor(() => expect(releases).toHaveLength(5));
    release(releases, 4);

    const concurrent = await run;
    const serial = await extractClaimCandidates({
      answers: answers(15),
      product: 'Deno',
      role,
      accounting: ledger(),
      transport,
      concurrency: 1,
    });

    expect(concurrent).toEqual(serial);
    expect(maxActive).toBe(4);
    expect(progress).toHaveBeenLastCalledWith({
      batchIndex: 4,
      completedBatches: 5,
      totalBatches: 5,
      cached: false,
    });
  });

  it('should resume validated batches without model calls and misses on answer, product, or profile changes', async () => {
    const batchCache = cache();
    const accounting = ledger();
    const original = answers(6);
    const first = await extractClaimCandidates({
      answers: original,
      product: 'Deno',
      role,
      accounting,
      transport,
      batchCache,
    });
    const before = Object.keys(accounting.state.calls).length;
    const mustNotDispatch: StructuredTransport = () => {
      return Promise.reject(new Error('Unexpected dispatch.'));
    };
    const onProgress = vi.fn<(progress: { cached: boolean }) => void>();

    const resumed = await extractClaimCandidates({
      answers: original,
      product: 'Deno',
      role,
      accounting,
      transport: mustNotDispatch,
      batchCache,
      onProgress,
    });

    expect(resumed).toEqual(first);
    expect(Object.keys(accounting.state.calls)).toHaveLength(before);
    expect(onProgress.mock.calls.every(([entry]) => entry.cached)).toBe(true);

    const changed = structuredClone(original);
    const changedAnswer = requireDefined(changed[0], 'changed answer');

    changedAnswer.text += ' Changed.';
    changedAnswer.digest = contentHash(changedAnswer.text);

    await extractClaimCandidates({
      answers: changed,
      product: 'Deno',
      role,
      accounting,
      transport,
      batchCache,
    });

    expect(Object.keys(accounting.state.calls)).toHaveLength(before + 1);

    await extractClaimCandidates({
      answers: original,
      product: 'Deno Deploy',
      role,
      accounting,
      transport,
      batchCache,
    });
    await extractClaimCandidates({
      answers: original,
      product: 'Deno',
      role: { ...role, promptVersion: 'changed' },
      accounting,
      transport,
      batchCache,
    });

    expect(Object.keys(accounting.state.calls)).toHaveLength(before + 5);
  });

  it('should retain valid concurrent batches after an invalid quote, and never cache the pruned one', async () => {
    const batchCache = cache();
    const invalid: StructuredTransport = (input) => {
      const value = output(input.prompt);
      const first = requireDefined(value.claims[0], 'first claim');

      if (first.answerId === 'answer-3') {
        first.quote = 'invented quotation';
      }

      return Promise.resolve({ output: input.schema.parse(value), usage: {} });
    };

    // The batch with the invented quotation loses that claim and is not
    // cached; every other concurrent batch is unaffected and is.
    await extractClaimCandidates({
      answers: answers(6),
      product: 'Deno',
      role,
      accounting: ledger(),
      transport: invalid,
      batchCache,
    });

    expect(batchCache.entries.size).toBe(1);

    const accounting = ledger();

    const resumed = await extractClaimCandidates({
      answers: answers(6),
      product: 'Deno',
      role,
      accounting,
      transport,
      batchCache,
    });

    expect(resumed.coverage.extractedAnswers).toBe(6);
    expect(Object.keys(accounting.state.calls)).toHaveLength(1);

    const entry = requireDefined(
      [...batchCache.entries.values()][0],
      'cached entry',
    );

    requireDefined(entry.output.claims[0], 'cached claim').quote =
      'tampered stored quotation';

    const tampered = extractClaimCandidates({
      answers: answers(6),
      product: 'Deno',
      role,
      accounting,
      transport,
      batchCache,
    });

    await expect(tampered).rejects.toThrow('quote_not_found');
    expect(Object.keys(accounting.state.calls)).toHaveLength(1);
  });

  it.each([true, false])(
    'should drain reservations and retry only undispatched admissions (reported usage: %s)',
    async (reported) => {
      const { accounting, getLedger, getAttempts } = createLazyLedger(
        (call) => ({
          maxUsd: call.reservedUsd * 1.5,
          maxTokens: Math.ceil((call.inputTokens + call.maxOutputTokens) * 1.5),
        }),
      );
      let dispatches = 0;
      const paid: StructuredTransport = async (input) => {
        dispatches += 1;

        // Allow the other admissions in the wave to observe this reservation.
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });

        return {
          output: input.schema.parse(output(input.prompt)),
          usage: reported
            ? { costUsd: 0, inputTokens: 1, outputTokens: 1 }
            : {},
        };
      };
      const result = await extractClaimCandidates({
        answers: answers(12),
        product: 'Deno',
        role,
        accounting,
        transport: paid,
      });

      expect(dispatches).toBe(reported ? 4 : 1);
      expect(getAttempts()).toBe(reported ? 7 : 5);
      expect(Object.keys(getLedger().state.calls)).toHaveLength(dispatches);
      expect(result.coverage).toMatchObject({
        extractedAnswers: reported ? 12 : 3,
        extractionStopReason: reported ? 'complete' : 'budget_exhausted',
      });
    },
  );

  it('should NOT retry failed provider calls while continuing distinct batches', async () => {
    const dispatched: string[] = [];
    const failing: StructuredTransport = (input) => {
      dispatched.push(firstSuppliedId(input.prompt));

      return Promise.reject(new Error('provider unavailable'));
    };
    const accounting = ledger();

    const result = await extractClaimCandidates({
      answers: answers(15),
      product: 'Deno',
      role,
      accounting,
      transport: failing,
    });

    expect(dispatched).toEqual([
      'answer-0',
      'answer-3',
      'answer-6',
      'answer-9',
      'answer-12',
    ]);
    expect(Object.keys(accounting.state.calls)).toHaveLength(5);
    expect(result.coverage.extractionStopReason).toBe('provider_unavailable');
  });

  it('should retain successes after an isolated provider failure and report partial coverage', async () => {
    const accounting = ledger();
    const batchCache = cache();
    const dispatched: string[] = [];
    const isolatedFailure: StructuredTransport = (input) => {
      const id = firstSuppliedId(input.prompt);

      dispatched.push(id);

      if (id === 'answer-3') {
        return Promise.reject(new Error('provider timeout'));
      }

      return transport(input);
    };

    const result = await extractClaimCandidates({
      answers: answers(15),
      product: 'Deno',
      role,
      accounting,
      transport: isolatedFailure,
      batchCache,
    });

    expect(dispatched).toHaveLength(5);
    expect(new Set(dispatched)).toHaveLength(5);
    expect(result.coverage).toMatchObject({
      suppliedAnswers: 15,
      extractedAnswers: 12,
      extractionStopReason: 'provider_unavailable',
    });
    expect(result.candidates).toHaveLength(12);
    expect(
      result.candidates.some((candidate) =>
        candidate.occurrences.some(
          (occurrence) => occurrence.answerId === 'answer-12',
        ),
      ),
    ).toBe(true);
    expect(batchCache.entries.size).toBe(4);

    const calls = Object.values(accounting.state.calls);

    expect(calls).toHaveLength(5);
    expect(calls.filter((call) => call.usage === undefined)).toHaveLength(1);
  });

  it('should stop new admissions after budget exhaustion while retaining already completed peers', async () => {
    const original = ledger();
    let admissions = 0;
    const accounting: ModelCallAccounting = {
      ...original,
      reserve: async (call) => {
        admissions += 1;

        if (admissions === 1) {
          throw new ModelBudgetError(
            'Admission exceeds remaining budget.',
            'exhausted',
          );
        }

        await original.reserve(call);
      },
    };

    const result = await extractClaimCandidates({
      answers: answers(15),
      product: 'Deno',
      role,
      accounting,
      transport,
    });

    expect(admissions).toBe(4);
    expect(Object.keys(original.state.calls)).toHaveLength(3);
    expect(result.candidates).toHaveLength(9);
    expect(result.coverage).toMatchObject({
      suppliedAnswers: 15,
      extractedAnswers: 9,
      extractionStopReason: 'budget_exhausted',
    });
  });

  it('should keep a provider gap non-cacheable when later successes reach the inventory limit', async () => {
    let calls = 0;
    const full: StructuredTransport = (input) => {
      calls += 1;

      if (firstClaim(input.prompt).answerId === 'answer-0') {
        return Promise.reject(new Error('provider timeout'));
      }

      return fortyClaims(input);
    };

    const result = await extractClaimCandidates({
      answers: answers(90),
      product: 'Deno',
      role,
      accounting: ledger(),
      transport: full,
    });

    expect(calls).toBe(26);
    expect(result.candidates).toHaveLength(1000);
    expect(result.coverage).toMatchObject({
      suppliedAnswers: 90,
      extractedAnswers: 75,
      extractionStopReason: 'provider_unavailable',
    });
  });

  it('should never persist a batch after cancellation', async () => {
    const controller = new AbortController();
    const batchCache = cache();
    const canceled: StructuredTransport = async (input) => {
      const value = await transport(input);

      controller.abort(new Error('cancelled by owner'));

      return value;
    };

    const result = extractClaimCandidates({
      answers: answers(3),
      product: 'Deno',
      role,
      accounting: ledger(),
      transport: canceled,
      batchCache,
      signal: controller.signal,
    });

    await expect(result).rejects.toThrow('cancelled by owner');
    expect(batchCache.put).not.toHaveBeenCalled();
  });

  it('should recheck ownership after validation and before persisting a batch', async () => {
    const base = ledger();
    let owned = true;
    const accounting: ModelCallAccounting = {
      deadlineAt,
      reserve: (call) => base.reserve(call),
      assertOwned: () => {
        if (!owned) {
          return Promise.reject(
            new ModelBudgetError('Owner changed.', 'ownership'),
          );
        }

        return Promise.resolve();
      },
      settle: async (id, usage) => {
        await base.settle(id, usage);
        owned = false;
      },
    };
    const batchCache = cache();

    const result = extractClaimCandidates({
      answers: answers(3),
      product: 'Deno',
      role,
      accounting,
      transport,
      batchCache,
    });

    await expect(result).rejects.toThrow('Owner changed');
    expect(batchCache.put).not.toHaveBeenCalled();
    expect(Object.keys(base.state.calls)).toHaveLength(1);
  });

  it('should NOT let clearing validated caches release existing unknown-cost reservations', async () => {
    const { accounting, getLedger } = createLazyLedger((call) => ({
      maxUsd: call.reservedUsd * 1.5,
      maxTokens: 1_000_000,
    }));
    let calls = 0;
    const unknownCost: StructuredTransport = (input) => {
      calls += 1;

      return Promise.resolve({
        output: input.schema.parse(output(input.prompt)),
        usage: {},
      });
    };
    const batchCache = cache();
    const input = {
      answers: answers(3),
      product: 'Deno',
      role,
      accounting,
      transport: unknownCost,
      batchCache,
    };

    const first = await extractClaimCandidates(input);

    expect(first.coverage.extractedAnswers).toBe(3);

    batchCache.entries.clear();

    const second = await extractClaimCandidates(input);

    expect(second.coverage).toMatchObject({
      extractedAnswers: 0,
      extractionStopReason: 'budget_exhausted',
    });
    expect(calls).toBe(1);
    expect(Object.keys(getLedger().state.calls)).toHaveLength(1);
  });

  it('should reserve inventory capacity before each wave and never exceed 1000 claims', async () => {
    let calls = 0;
    const full: StructuredTransport = (input) => {
      calls += 1;

      return fortyClaims(input);
    };

    const result = await extractClaimCandidates({
      answers: answers(90),
      product: 'Deno',
      role,
      accounting: ledger(),
      transport: full,
    });

    expect(calls).toBe(25);
    expect(result.candidates).toHaveLength(1000);
    expect(result.coverage).toMatchObject({
      extractedAnswers: 75,
      extractionStopReason: 'inventory_limit',
    });
  });
});
