import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyFixtureConfig,
  copyFixtureSnapshot,
  finalDraft,
} from '../agents/__fixtures__/copy';
import { createMemoryModelAccounting } from '../models/accounting';
import { testModelProfileFixture } from '../models/profile-fixture';
import { buildFactCatalog } from '../agents/facts';
import { structuredCallReservation } from '../models/structured';
import { copyEditCall, editCopyDraft, readCopyEdits } from './copy-editor';
import { writeOutputSchema } from './schemas';

type EditPrompt = {
  currentDraft: unknown;
  findings: string[];
  previousEdits: { editedDraft?: unknown }[];
  previousReviews: unknown;
  rules: Record<string, unknown>;
  facts: { facts: unknown[] };
};

/** The verifier's prompt, as the shape the test checks. */
const parsePrompt = (prompt: string) => {
  return JSON.parse(prompt) as EditPrompt;
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const directory = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aeo-copy-editor-'));

  directories.push(dir);

  return dir;
};

describe('CopyEditor - editCopyDraft()', () => {
  it('should let the pinned verifier edit directly and retain its edits when a replacement continues the review', async () => {
    const dir = await directory();
    const role = testModelProfileFixture().roles.premiseVerifier;
    const edited = finalDraft();
    const initial = { ...edited, hero: undefined };
    const checkpoint = vi.fn(async () => {});
    const args = {
      dir,
      root: process.cwd(),
      scope: 'frozen-evidence',
      round: 1,
      draft: initial,
      errors: ['hero is required'],
      reviewHistory: {},
      checkpoint,
      validation: {
        config: copyFixtureConfig,
        snapshot: copyFixtureSnapshot,
        runId: 'run-1',
        configVersion: 1,
        grounding: null,
        secrets: [],
        verifierRole: role,
        accounting: createMemoryModelAccounting({
          maxUsd: 5,
          maxTokens: 5_000_000,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
    };

    const result = await editCopyDraft({
      ...args,
      transport: (request) => {
        expect(request.role).toEqual(role);
        // The verifier is asked for the complete edited draft, never a review
        // object, over the draft it found the issues in.
        expect(request.schema).toBe(writeOutputSchema);

        const input = parsePrompt(request.prompt);

        expect(input.currentDraft).toEqual(initial);
        expect(input.findings).toEqual(['hero is required']);
        expect(input.previousEdits).toEqual([]);

        return Promise.resolve({
          output: request.schema.parse(edited),
          usage: { inputTokens: 100, outputTokens: 100, costUsd: 0.001 },
        });
      },
    });

    expect(result).toEqual(edited);
    expect(checkpoint).toHaveBeenCalledWith(['PENDING/copy-edits.json']);

    const replacement = await directory();

    await cp(path.join(dir, 'PENDING'), path.join(replacement, 'PENDING'), {
      recursive: true,
    });
    await expect(
      editCopyDraft({
        ...args,
        dir: replacement,
        transport: () =>
          Promise.reject(new Error('A saved edit must not be generated again')),
      }),
    ).resolves.toEqual(edited);

    const revised = { ...edited, confidence: 0.8 };

    await editCopyDraft({
      ...args,
      dir: replacement,
      round: 2,
      draft: edited,
      errors: ['Another concrete finding'],
      transport: (request) => {
        const input = parsePrompt(request.prompt);

        expect(input.previousEdits).toHaveLength(1);
        expect(input.previousEdits[0]?.editedDraft).toEqual(edited);
        expect(input.currentDraft).toEqual(edited);

        return Promise.resolve({
          output: request.schema.parse(revised),
          usage: { inputTokens: 100, outputTokens: 100, costUsd: 0.001 },
        });
      },
    });
    expect(await readCopyEdits(replacement, args.scope)).toHaveLength(2);
    expect(await readCopyEdits(replacement, 'different-evidence')).toEqual([]);
  });

  it('should fit a large evidence catalog without dropping the current draft evidence or reviewer context', () => {
    const catalog = buildFactCatalog({
      snapshot: copyFixtureSnapshot,
      config: copyFixtureConfig,
      runId: 'run-1',
    });

    const required = catalog.facts.find(
      (fact) => fact.factId === 'first:gemini:mentions',
    );

    if (!required) {
      throw new Error('Expected the fixture catalog to hold the Gemini fact.');
    }

    catalog.facts.push(
      ...Array.from({ length: 500 }, (_, index) => ({
        ...required,
        factId: `optional:${index}`,
        sentence: 'An unrelated measured fact. '.repeat(100),
      })),
    );

    const role = testModelProfileFixture().roles.premiseVerifier;
    const draft = writeOutputSchema.parse(finalDraft());
    const call = copyEditCall({
      draft,
      errors: ['Keep the company-specific finding'],
      edits: [
        {
          inputDigest: 'first',
          round: 1,
          draft,
          errors: ['Prior finding'],
          editedDraft: draft,
        },
      ],
      reviewHistory: {},
      catalog,
      context: { brand: copyFixtureConfig.brand },
      rules: {},
      role,
    });

    const prompt = parsePrompt(call.prompt);

    expect(prompt.facts.facts).toContainEqual(
      expect.objectContaining({
        factId: required.factId,
        sentence: required.sentence,
      }),
    );
    expect(prompt.currentDraft).toEqual(draft);
    expect(prompt.previousEdits[0]).toEqual({
      round: 1,
      findings: ['Prior finding'],
      editedDraft: draft,
    });
    expect(prompt.facts.facts.length).toBeLessThan(catalog.facts.length);
    expect(structuredCallReservation(call).inputTokens).toBeLessThanOrEqual(
      role.maxInputTokens,
    );
  });

  it('should give up older edits, then reviews, then the company documents before refusing an edit that does not fit', () => {
    const catalog = buildFactCatalog({
      snapshot: copyFixtureSnapshot,
      config: copyFixtureConfig,
      runId: 'run-1',
    });

    const draft = writeOutputSchema.parse(finalDraft());
    const base = testModelProfileFixture().roles.premiseVerifier;
    const edit = (round: number) => {
      return {
        inputDigest: `d${round}`,
        round,
        draft,
        errors: [`Finding ${round}`],
        editedDraft: draft,
      };
    };

    const review = (text: string) => {
      return {
        text,
        review: {
          path: 'intro.0',
          passed: false,
          errors: ['x'.repeat(400)],
          premises: [],
          allPremisesCovered: true,
          actionAppropriate: true,
        },
      };
    };

    const rules = {
      'RULES.md': 'Voice rules. '.repeat(100),
      'company/COMPANY.md': 'Company. '.repeat(800),
      'company/positioning.md': 'Positioning. '.repeat(800),
    };

    const args = {
      draft,
      errors: ['Fix the intro'],
      edits: [edit(1), edit(2), edit(3)],
      reviewHistory: {
        'intro.0': [review('a'), review('b'), review('c'), review('d')],
      } as never,
      catalog,
      context: { brand: copyFixtureConfig.brand },
      rules,
    };

    const roomy = copyEditCall({
      ...args,
      role: { ...base, maxInputTokens: 100_000 },
    });

    expect(roomy.trimmed).toEqual([]);

    // Room for the draft, its facts and the voice rules, not for the history
    // of edits and reviews on top.
    const draftBytes = Buffer.byteLength(
      JSON.stringify({ currentDraft: draft, findings: args.errors }),
    );
    const tight = copyEditCall({
      ...args,
      role: { ...base, maxInputTokens: draftBytes + 24_000 },
    });

    expect(tight.trimmed).toEqual([
      'older_edits',
      'all_edits',
      'older_reviews',
      'all_reviews',
      'company_rules',
    ]);

    const prompt = parsePrompt(tight.prompt);

    expect(prompt.currentDraft).toEqual(draft);
    expect(prompt.findings).toEqual(['Fix the intro']);
    expect(prompt.previousEdits).toEqual([]);
    expect(prompt.previousReviews).toEqual({});
    expect(Object.keys(prompt.rules)).toEqual(['RULES.md']);
    // Below what the draft and its findings need, the edit is refused: the
    // report then ships on its verified facts.
    expect(() =>
      copyEditCall({ ...args, role: { ...base, maxInputTokens: 4000 } }),
    ).toThrow('model_input_limit');
  });
});
