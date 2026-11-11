import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveReportModel } from '../engine/run-models';
import { readEnv, requireEnv } from '../lib/env';
import { createMemoryModelAccounting } from '../models/accounting';
import { gatewayCatalogSource } from '../models/catalog';
import { localModelProfile } from '../models/local-profile';
import { copyDir, draftCopy, readCopyDocuments } from './copy';

// ============================================================================
// PAID, maintainer-run (.claude/rules/tests-cost-nothing.md): one request to
// one gateway model. It writes a finished run's report narrative the way
// the write stage does (method release spec §4.5): the stage's
// instructions, the documents that run gave its writer and the draft's
// schema, on the copy role of the model named. The call is reserved at its
// ceiling before it is made, so a model whose ceiling is above
// AEO_LIVE_MAX_USD (1 by default) is refused and nothing is spent.
//
// It answers what no fake can: whether a model returns a draft the schema
// accepts from one request, what it cites, and what the request costs. The
// draft and its usage are written to AEO_LIVE_OUTPUT_DIR. Both that and
// AEO_LIVE_RUN_DIR, the finished run directory whose COPY/ documents are
// sent, must lie outside the repository: they hold a real audit.
//
//   AI_GATEWAY_API_KEY=... AEO_LIVE_WRITE_MODEL=<gateway model id> \
//     AEO_LIVE_RUN_DIR=/path/to/a/finished/run \
//     AEO_LIVE_OUTPUT_DIR=/path/outside/the/repo \
//     capped npx vitest run --config vitest.live.config.ts \
//     src/codex-workflow/copy-writer.live.spec.ts
// ============================================================================

const defaultMaxUsd = 1;

const repository = path.resolve(import.meta.dirname, '..', '..');

const outsideRepository = (name: string): string => {
  const dir = path.resolve(
    requireEnv(
      name,
      `Please set ${name} to a directory outside the repository.`,
    ),
  );

  if (!path.relative(repository, dir).startsWith('..')) {
    throw new Error(
      `${name} is inside the repository (${dir}). A real audit is not fit to commit; name a directory outside it.`,
    );
  }

  return dir;
};

/** Every file under COPY/ of the run, as materializeCopyInputs names them. */
const copyFilesOf = (runDir: string): string[] => {
  const walk = (relative: string): string[] => {
    return readdirSync(path.join(runDir, relative), {
      withFileTypes: true,
    }).flatMap((entry) => {
      const file = path.posix.join(relative, entry.name);

      return entry.isDirectory() ? walk(file) : [file];
    });
  };

  return walk(copyDir).sort();
};

const blockSchema = z.looseObject({
  text: z.string(),
  basisFactIds: z.array(z.string()),
  premises: z.array(z.looseObject({ basisFactIds: z.array(z.string()) })),
});
const draftShape = z.looseObject({
  hero: z.looseObject({ title: blockSchema, subtitle: blockSchema }),
  intro: z.array(blockSchema),
});
const factsShape = z.looseObject({
  facts: z.array(z.looseObject({ factId: z.string() })),
});
const banlistShape = z.looseObject({ phrases: z.array(z.string()) });
const contextShape = z.looseObject({
  sections: z.array(z.looseObject({ key: z.string() })),
});

describe('the copywriter request (live, paid)', () => {
  let runDir: string;
  let outputDir: string;
  let modelId: string;
  let maxUsd: number;

  beforeAll(() => {
    requireEnv('AI_GATEWAY_API_KEY');
    modelId = requireEnv(
      'AEO_LIVE_WRITE_MODEL',
      'Please set AEO_LIVE_WRITE_MODEL to the gateway model that writes the draft.',
    );
    runDir = outsideRepository('AEO_LIVE_RUN_DIR');
    outputDir = outsideRepository('AEO_LIVE_OUTPUT_DIR');
    maxUsd = Number(readEnv('AEO_LIVE_MAX_USD') ?? defaultMaxUsd);

    if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
      throw new Error(
        'AEO_LIVE_MAX_USD is not a positive amount. Please set it to the most this suite may spend, in US dollars.',
      );
    }

    mkdirSync(outputDir, { recursive: true });
  });

  it('should return a draft the schema accepts, citing only facts it was given', async () => {
    const model = await resolveReportModel(modelId, path.join(tmpdir(), 'x'), {
      source: gatewayCatalogSource({ fetch: globalThis.fetch }),
      now: new Date(),
      freeze: false,
    });
    const role = localModelProfile(model, { searchProvider: 'disabled' }).roles
      .copy;
    const documents = await readCopyDocuments(runDir, copyFilesOf(runDir));
    const sections = contextShape
      .parse(JSON.parse(documents['AUDIT_CONTEXT.json'] ?? '{}'))
      .sections.map((section) => section.key);
    const facts = new Set(
      factsShape
        .parse(JSON.parse(documents['FACTS.json'] ?? '{}'))
        .facts.map((fact) => fact.factId),
    );
    const banned = banlistShape.parse(
      JSON.parse(documents['banlist.json'] ?? '{"phrases":[]}'),
    ).phrases;
    // The reservation is refused before the request when it exceeds this.
    const accounting = createMemoryModelAccounting({
      maxUsd,
      maxTokens: 5_000_000,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const startedAt = Date.now();

    const { draft, usage, omitted } = await draftCopy({
      role,
      documents,
      sections,
      accounting,
    });

    const { hero, intro } = draftShape.parse(draft);
    const blocks = [hero.title, hero.subtitle, ...intro];
    const cited = blocks.flatMap((block) => [
      ...block.basisFactIds,
      ...block.premises.flatMap((premise) => premise.basisFactIds),
    ]);
    const unknownFacts = [...new Set(cited)].filter((id) => !facts.has(id));
    const prose = blocks.map((block) => block.text).join(' ');
    const bannedUsed = banned.filter((word) =>
      prose.toLowerCase().includes(word.toLowerCase()),
    );

    writeFileSync(
      path.join(outputDir, `${modelId.replaceAll('/', '_')}.json`),
      `${JSON.stringify(
        {
          model: modelId,
          verified: model.stageRuntimeVerifiedAt,
          seconds: (Date.now() - startedAt) / 1000,
          documents: Object.fromEntries(
            Object.entries(documents).map(([name, text]) => [
              name,
              Buffer.byteLength(text),
            ]),
          ),
          omitted,
          usage,
          words: prose.split(/\s+/).length,
          citedFacts: new Set(cited).size,
          unknownFacts,
          bannedUsed,
          draft,
        },
        null,
        2,
      )}\n`,
    );

    expect(unknownFacts).toEqual([]);
    expect(bannedUsed).toEqual([]);
    expect(prose).not.toMatch(/https?:\/\//);
  });
});
