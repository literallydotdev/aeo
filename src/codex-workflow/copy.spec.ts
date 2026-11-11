import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finalDraft } from '../agents/__fixtures__/copy';
import { quotedAnswerHeading } from '../agents/copywriter-input';
import { createMemoryModelAccounting } from '../models/accounting';
import { testModelProfileFixture } from '../models/profile-fixture';
import {
  structuredCallReservation,
  type StructuredTransport,
} from '../models/structured';
import { copyDraftCall, draftCopy, readCopyDocuments } from './copy';
import { stagePrompts } from './prompts';
import { writeOutputSchema } from './schemas';

// ============================================================================
// The copywriter is one request (method release spec §4.5): the write
// stage's instructions, every document it is given and the draft's schema.
// It has no tools and no files, so what it may say is what the request
// holds.
// ============================================================================

const role = testModelProfileFixture().roles.copy;

const facts = (kinds: readonly string[]) => {
  return JSON.stringify({
    version: 1,
    runId: 'run-1',
    facts: kinds.map((kind, index) => ({
      factId: `fact-${index}`,
      section: 'file_stores',
      kind,
      sentence: `Acme Files was named in ${index} of 22 planned answers.`,
    })),
  });
};

const documents = (overrides: Record<string, string> = {}) => {
  return {
    'RULES.md': '# Rules\nWrite plainly.',
    'CRITERIA.md': '# What the reviewers refuse',
    'AUDIT_CONTEXT.json': '{"brand":{"name":"Acme Files"}}',
    'banlist.json': '["synergy"]',
    'company/COMPANY.md': 'Acme Audits',
    'company/positioning.md': 'Plain and factual.',
    'company/services.md': 'Audits.',
    'FACTS.json': facts(['measurement', 'observed_claim', 'assessment']),
    'SNAPSHOT.md': `# Report scope\n- file_stores\n${quotedAnswerHeading}## file_stores\n> "Acme Files is fast."\n`,
    ...overrides,
  };
};

type DraftPrompt = { documents: Record<string, string>; omitted?: string[] };

const promptOf = (call: { prompt: string }) => {
  return JSON.parse(call.prompt) as DraftPrompt;
};

/** The role one token too small for `call`: what forces the next thing to
 * be given up. */
const tooSmallFor = (call: ReturnType<typeof copyDraftCall>) => {
  return {
    ...role,
    maxInputTokens: structuredCallReservation(call).inputTokens - 1,
  };
};

describe('copy - copyDraftCall()', () => {
  it('should carry the write instructions, the draft schema and every document, complete', () => {
    const given = documents();

    const call = copyDraftCall({ role, documents: given });

    expect(call.system).toBe(stagePrompts.write);
    expect(call.schema).toBe(writeOutputSchema);
    expect(call.role).toBe(role);
    expect(promptOf(call)).toEqual({ documents: given });
    expect(call.omitted).toEqual([]);
  });

  it('should give up, in order, the quoted answers, the company notes and the unverified claims, and tell the writer what it left out', () => {
    const given = documents();
    const whole = copyDraftCall({ role, documents: given });

    const first = copyDraftCall({ role: tooSmallFor(whole), documents: given });
    const second = copyDraftCall({
      role: tooSmallFor(first),
      documents: given,
    });
    const third = copyDraftCall({
      role: tooSmallFor(second),
      documents: given,
    });

    expect(first.omitted).toEqual(['quoted answer material']);
    expect(promptOf(first).documents['SNAPSHOT.md']).toBe(
      '# Report scope\n- file_stores\n',
    );
    expect(promptOf(first).documents['company/COMPANY.md']).toBe('Acme Audits');
    expect(second.omitted).toEqual(['quoted answer material', 'company notes']);
    expect(Object.keys(promptOf(second).documents)).toEqual([
      'RULES.md',
      'CRITERIA.md',
      'AUDIT_CONTEXT.json',
      'banlist.json',
      'FACTS.json',
      'SNAPSHOT.md',
    ]);
    expect(third.omitted).toEqual([
      'quoted answer material',
      'company notes',
      'unverified claim observations',
    ]);
    // The measured facts and the assessments are never given up.
    expect(
      (
        JSON.parse(promptOf(third).documents['FACTS.json'] ?? '{}') as {
          facts: { kind: string }[];
        }
      ).facts.map((fact) => fact.kind),
    ).toEqual(['measurement', 'assessment']);
    expect(promptOf(third).omitted).toEqual(third.omitted);
  });

  it('should refuse a request that cannot carry the facts and the rules, never write from less', () => {
    const given = documents();
    const smallest = copyDraftCall({
      role: {
        ...role,
        maxInputTokens: structuredCallReservation(
          copyDraftCall({ role, documents: given }),
        ).inputTokens,
      },
      documents: given,
    });
    const leanest = [1, 2, 3].reduce(
      (call) => copyDraftCall({ role: tooSmallFor(call), documents: given }),
      smallest,
    );

    expect(() =>
      copyDraftCall({ role: tooSmallFor(leanest), documents: given }),
    ).toThrow('model_input_limit');
  });
});

describe('copy - draftCopy()', () => {
  it('should ask the copy role once, with no tools, and return its draft and what the call used', async () => {
    const draft = finalDraft();
    const asked: unknown[] = [];
    const transport: StructuredTransport = (request) => {
      asked.push(request);

      return Promise.resolve({
        output: draft as never,
        usage: {
          inputTokens: 15_000,
          cachedInputTokens: 0,
          outputTokens: 900,
          costUsd: 0.04,
        },
      });
    };
    const accounting = createMemoryModelAccounting({
      maxUsd: 5,
      maxTokens: 1_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });
    const given = documents();

    const result = await draftCopy(
      { role, documents: given, accounting },
      transport,
    );

    expect(result.draft).toEqual(draft);
    expect(result.usage).toMatchObject({
      inputTokens: 15_000,
      outputTokens: 900,
    });
    expect(result.omitted).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      roleName: 'copy',
      role,
      system: stagePrompts.write,
    });
    // Charged to the run's ledger as the copy role's call.
    expect(Object.values(accounting.state.calls)).toMatchObject([
      { role: 'copy', usage: { costUsd: 0.04 } },
    ]);
  });
});

describe('copy - readCopyDocuments()', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('should read the documents the pass wrote, by their name under COPY/, and nothing an earlier pass left there', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeo-copy-documents-'));

    directories.push(dir);
    await mkdir(path.join(dir, 'COPY', 'company'), { recursive: true });
    await writeFile(path.join(dir, 'COPY', 'RULES.md'), 'rules');
    await writeFile(path.join(dir, 'COPY', 'company', 'COMPANY.md'), 'voice');
    await writeFile(path.join(dir, 'COPY', 'NOTES.md'), 'an earlier rewrite');

    expect(
      await readCopyDocuments(dir, [
        'COPY/RULES.md',
        'COPY/company/COMPANY.md',
      ]),
    ).toEqual({ 'RULES.md': 'rules', 'company/COMPANY.md': 'voice' });
  });
});
