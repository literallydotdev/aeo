import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { syntheticExample } from '../author/examples';
import {
  authorBrand,
  authorFiles,
  authorSessionInputs,
  materializeAuthorWorkdir,
  packAuthorWorkspace,
  restoreAuthorWorkspace,
} from './author';
import { codexConfigToml } from './codex-home';
import { runStage, stageInputsDigest, type StageContext } from './stage';

// ============================================================================
// The author stage through the runner against a fake `codex` (Codex author
// spec §9, "Stage"): the descriptor's digest and packet, the read-only
// sandbox, the research server registered for this stage only, a refusal
// resumed with the host's findings, a fatal verdict, and the retry of a
// session that never submitted.
// ============================================================================

type AuthorPacket = {
  stage: string;
  continuation: boolean;
  files: Record<string, unknown>;
};

/** Parses JSON the runner wrote, as the shape the test checks. */
const parseJson = <T>(text: string): T => {
  return JSON.parse(text) as T;
};

const brief = {
  companyName: 'Example Tools',
  website: 'https://example.com',
  desiredRecommendation: 'The tool developers use to review database changes',
};
const notes = {
  verdict: 'fit',
  confidence: 0.9,
  reasons: ['RESEARCH/1.md describes the product'],
  briefContradiction: false,
  proposedFacts: [],
};
const submission = { config: syntheticExample, notes };

/** A fake codex for the author: consumes stdin, records its arguments and
 * environment, emits events, and writes the Nth scripted submission the
 * way the submit tool would (nothing when the script says so). */
const fakeCodex = async (
  dir: string,
  outputs: unknown[],
  { missingOutputAttempts = 0 }: { missingOutputAttempts?: number } = {},
): Promise<string> => {
  const script = path.join(dir, 'fake-codex.sh');
  const outputsFile = path.join(dir, 'fake-outputs.json');

  await writeFile(outputsFile, JSON.stringify(outputs));
  await writeFile(
    script,
    [
      '#!/bin/sh',
      `cat > "${dir}/fake-stdin"`,
      `printf '%s\\n' "$@" >> "${dir}/fake-args"`,
      'echo \'{"type":"thread.started","thread_id":"12345678-1234-1234-1234-123456789abc"}\'',
      'mkdir -p "$CODEX_HOME/sessions"; echo \'{"type":"session_meta"}\' >> "$CODEX_HOME/sessions/rollout-12345678-1234-1234-1234-123456789abc.jsonl"',
      `COUNT="${dir}/fake-attempts"`,
      'N=$(cat "$COUNT" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "$COUNT"',
      `cp "$CODEX_HOME/config.toml" "${dir}/fake-config-$N.toml"`,
      `if [ "$N" -le ${missingOutputAttempts} ]; then exit 0; fi`,
      'echo \'{"type":"turn.completed","usage":{"input_tokens":500,"output_tokens":50}}\'',
      `mkdir -p OUT/author; node -e "const o=JSON.parse(require('fs').readFileSync('${outputsFile}','utf8'));require('fs').writeFileSync('OUT/author/0.json', JSON.stringify(o[Math.min(${'$N'}-1,o.length-1)]))"`,
    ].join('\n'),
  );
  await chmod(script, 0o755);

  return script;
};

const workdir = async (previous?: { config: unknown; notes: string }) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aeo-author-stage-'));

  await materializeAuthorWorkdir({
    dir,
    brief,
    previous: previous ?? null,
  });

  const ctx: Omit<StageContext, 'command'> = {
    dir,
    brand: authorBrand(brief),
    answers: [],
    timeoutMs: 20_000,
    research: {
      command: '/usr/bin/env',
      args: ['node', '/srv/author-tools.js'],
      env: {
        AEO_AUTHOR_WORKDIR: dir,
        DATAFORSEO_LOGIN: 'dataforseo-test-login',
      },
    },
    verdict: () => Promise.resolve({ errors: [] }),
  };

  return { dir, ctx };
};

describe('Stage - runStage() for the author stage', () => {
  beforeAll(() => {
    process.env.AI_GATEWAY_API_KEY = 'test-key';
  });

  it('should materialise AUTHOR/ from the brief and the author files, and bind the session to everything but PREVIOUS/', async () => {
    const { dir } = await workdir({
      config: syntheticExample,
      notes: 'Add Foo',
    });

    const files = await authorFiles(dir);

    expect(files).toEqual([
      'AUTHOR/BRIEF.md',
      'AUTHOR/PREVIOUS/config.json',
      'AUTHOR/PREVIOUS/notes.md',
      'AUTHOR/RULES.md',
      'AUTHOR/SCHEMA.json',
      'AUTHOR/banlist.json',
      'AUTHOR/examples/literally.json',
      'AUTHOR/examples/synthetic.json',
    ]);
    expect(authorSessionInputs(files)).not.toContain(
      'AUTHOR/PREVIOUS/notes.md',
    );
    expect(await readFile(path.join(dir, 'AUTHOR/BRIEF.md'), 'utf8')).toContain(
      '<untrusted-customer-data>',
    );
    expect(
      await readFile(path.join(dir, 'AUTHOR/PREVIOUS/notes.md'), 'utf8'),
    ).toContain('<untrusted-review-notes>\nAdd Foo');
    expect(
      parseJson<{ properties: unknown }>(
        await readFile(path.join(dir, 'AUTHOR/SCHEMA.json'), 'utf8'),
      ).properties,
    ).toHaveProperty('config');
  });

  it('should run one read-only session with the research server registered, pipe every AUTHOR/ document, and accept the submission', async () => {
    const { dir, ctx } = await workdir();
    const command = await fakeCodex(dir, [submission]);
    const run = await runStage({ ...ctx, command }, 'author');

    expect(run.errors).toEqual([]);
    expect(run.ok).toBe(true);
    expect(run.summary).toEqual({
      batches: 1,
      reused: 0,
      attempts: 1,
      refusals: 0,
    });
    expect(run.usage).toEqual({ inputTokens: 500, outputTokens: 50 });

    const args = (await readFile(path.join(dir, 'fake-args'), 'utf8')).split(
      '\n',
    );

    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).not.toContain('--ephemeral');

    const config = await readFile(path.join(dir, 'fake-config-1.toml'), 'utf8');

    expect(config).toContain('[mcp_servers.research]');
    expect(config).toContain('command = "/usr/bin/env"');
    expect(config).toContain('args = ["node", "/srv/author-tools.js"]');
    expect(config).toContain(`AEO_AUTHOR_WORKDIR = ${JSON.stringify(dir)}`);
    expect(config).toContain('DATAFORSEO_LOGIN = "dataforseo-test-login"');
    expect(config).toContain(
      '[mcp_servers.research.tools.submit]\napproval_mode = "approve"',
    );

    const input = parseJson<AuthorPacket>(
      await readFile(path.join(dir, 'fake-stdin'), 'utf8'),
    );

    expect(input.stage).toBe('author');
    expect(input.continuation).toBe(false);
    expect(Object.keys(input.files).sort()).toEqual(await authorFiles(dir));
    expect(input.files['AUTHOR/RULES.md']).toContain('Coding agents');
    expect(input.files['AUTHOR/examples/synthetic.json']).toHaveProperty(
      ['brand', 'name'],
      'Example Tools',
    );

    const stored = parseJson<unknown>(
      await readFile(path.join(dir, 'OUT/author/0.json'), 'utf8'),
    );

    expect(stored).toHaveProperty(['config', 'brand', 'domain'], 'example.com');
    expect(
      await readFile(path.join(dir, 'OUT/author.inputs.sha'), 'utf8'),
    ).toBe(await stageInputsDigest(ctx, 'author'));
  });

  it('should register the research server for the author stage only', async () => {
    const { dir } = await workdir();

    expect(codexConfigToml(dir)).not.toContain('mcp_servers');
    await expect(
      runStage(
        { dir, brand: authorBrand(brief), answers: [], command: '/x' },
        'author',
      ),
    ).rejects.toThrow('research tool server');
  });

  it("should resume the same conversation with the host's findings after a refused submission", async () => {
    const { dir, ctx } = await workdir();
    const verdicts: unknown[] = [];
    let calls = 0;
    const command = await fakeCodex(dir, [submission, submission]);
    const run = await runStage(
      {
        ...ctx,
        command,
        verdict: (value) => {
          verdicts.push(value);
          calls += 1;

          return Promise.resolve(
            calls === 1
              ? {
                  errors: [
                    'proposedFacts.0.sourceUrls: cite only what you read',
                  ],
                }
              : { errors: [] },
          );
        },
      },
      'author',
    );

    expect(run.ok).toBe(true);
    expect(run.summary).toMatchObject({ attempts: 2, refusals: 1 });
    expect(verdicts).toHaveLength(2);

    const args = await readFile(path.join(dir, 'fake-args'), 'utf8');

    expect(args).toContain('resume\n12345678-1234-1234-1234-123456789abc\n-');

    const stdin = await readFile(path.join(dir, 'fake-stdin'), 'utf8');

    expect(stdin).toContain('Continue the same authoring');
    expect(stdin).toContain('cite only what you read');

    const packet = parseJson<AuthorPacket>(stdin.split('\n').at(-1) ?? 'null');

    expect(packet.continuation).toBe(true);
    expect(packet.files).toEqual({});

    const refusals = await readFile(
      path.join(dir, 'JOURNAL/author-0.refusals.jsonl'),
      'utf8',
    );

    expect(refusals).toContain('cite only what you read');
  });

  it('should end after a fatal verdict without another session', async () => {
    const { dir, ctx } = await workdir();
    const command = await fakeCodex(dir, [submission, submission, submission]);
    const run = await runStage(
      {
        ...ctx,
        command,
        verdict: () =>
          Promise.resolve({ errors: ['brief_mismatch'], fatal: true }),
      },
      'author',
    );

    expect(run.ok).toBe(false);
    expect(run.summary).toMatchObject({ attempts: 1, refusals: 1 });
    expect(run.errors[0]).toContain('brief_mismatch');
    expect(await readFile(path.join(dir, 'fake-attempts'), 'utf8')).toBe('1\n');
  });

  it('should retry a session that ended without submitting, and deliver nothing when none does', async () => {
    const { dir, ctx } = await workdir();
    const run = await runStage(
      {
        ...ctx,
        command: await fakeCodex(dir, [submission], {
          missingOutputAttempts: 1,
        }),
      },
      'author',
    );

    expect(run.ok).toBe(true);
    expect(run.summary).toMatchObject({ attempts: 2, refusals: 0 });

    const failures = await readFile(
      path.join(dir, 'JOURNAL/author-0.failures.jsonl'),
      'utf8',
    );

    expect(failures).toContain('without an output file');

    const never = await workdir();
    const none = await runStage(
      {
        ...never.ctx,
        command: await fakeCodex(never.dir, [submission], {
          missingOutputAttempts: 9,
        }),
      },
      'author',
    );

    expect(none.ok).toBe(false);
    expect(none.summary).toMatchObject({ attempts: 3 });
  });

  it('should resume the retained conversation for a change request, with PREVIOUS/ appended', async () => {
    const { dir, ctx } = await workdir();
    const command = await fakeCodex(dir, [submission, submission]);

    await runStage({ ...ctx, command }, 'author');
    await writeFile(path.join(dir, 'fake-args'), '');
    await materializeAuthorWorkdir({
      dir,
      brief,
      previous: { config: syntheticExample, notes: 'Add Sample Three' },
    });

    const revised = await runStage({ ...ctx, command }, 'author');

    expect(revised.ok).toBe(true);
    expect(revised.summary).toMatchObject({ reused: 0, attempts: 1 });
    expect(await readFile(path.join(dir, 'fake-args'), 'utf8')).toContain(
      'resume',
    );

    const stdin = await readFile(path.join(dir, 'fake-stdin'), 'utf8');

    expect(stdin).toContain('Continue the same authoring');

    const packet = parseJson<AuthorPacket>(stdin.split('\n').at(-1) ?? 'null');

    expect(Object.keys(packet.files)).toEqual([
      'AUTHOR/PREVIOUS/config.json',
      'AUTHOR/PREVIOUS/notes.md',
    ]);
    expect(packet.files['AUTHOR/PREVIOUS/notes.md']).toContain(
      'Add Sample Three',
    );
  });

  it('should pack the workspace within its cap, dropping the rollout first, and restore it', async () => {
    const { dir, ctx } = await workdir();

    await runStage(
      { ...ctx, command: await fakeCodex(dir, [submission]) },
      'author',
    );
    await writeFile(
      path.join(dir, 'RESEARCH/1.md'),
      '# page\n- n: 1\n- kind: fetch\n- url: https://example.com/\n- finalUrl: https://example.com/\n- title: page\n- fetchedAt: 2026-09-15T00:00:00.000Z\n\n<untrusted-web-content>\ntext\n</untrusted-web-content>\n',
    );

    const full = await packAuthorWorkspace(dir);

    expect(full.rolloutDropped).toBe(false);
    expect(Object.keys(full.files)).toEqual(
      expect.arrayContaining([
        'OUT/author/0.json',
        'OUT/author/0.inputs.sha',
        'RESEARCH/1.md',
        'JOURNAL/author-0.session.json',
        '.codex-home/sessions/rollout-12345678-1234-1234-1234-123456789abc.jsonl',
      ]),
    );

    const capped = await packAuthorWorkspace(dir, full.bytes - 1);

    expect(capped.rolloutDropped).toBe(true);
    expect(Object.keys(capped.files)).not.toContain(
      'JOURNAL/author-0.session.json',
    );
    expect(Object.keys(capped.files)).toContain('OUT/author/0.json');

    const other = await mkdtemp(path.join(tmpdir(), 'aeo-author-restore-'));

    await restoreAuthorWorkspace(other, full);
    expect(await readFile(path.join(other, 'RESEARCH/1.md'), 'utf8')).toContain(
      'text',
    );
    await expect(
      restoreAuthorWorkspace(other, {
        ...full,
        files: { '../escape': 'x' },
      }),
    ).rejects.toThrow('Unexpected workspace path');
  });
});

describe('Author - citedSources()', () => {
  const source = (finalUrl: string) => {
    return { id: `src_${finalUrl}`, finalUrl, requestedUrl: finalUrl } as never;
  };
  const document = (n: number, url: string, finalUrl = url) => {
    return {
      path: `RESEARCH/${n}.md`,
      header: {
        n,
        kind: 'fetch' as const,
        url,
        finalUrl,
        title: '',
        fetchedAt: '2026-09-15T00:00:00.000Z',
      },
      text: '',
      source: source(finalUrl),
    };
  };

  it('should seed only the pages the facts cite, most cited first, once per source', async () => {
    const { citedSources } = await import('./author');
    const documents = [
      document(1, 'https://example.com/'),
      document(2, 'https://example.com/docs/'),
      document(3, 'https://example.com/pricing'),
      // A redirect: requested under one URL, landed on another already
      // read; the same source must not be seeded twice.
      document(4, 'https://example.com/home', 'https://example.com/'),
      { ...document(5, 'https://example.com/blog'), source: null },
    ];

    const facts = [
      { sourceUrls: ['https://example.com/docs', 'https://example.com/#top'] },
      { sourceUrls: ['https://example.com/docs'] },
      { sourceUrls: ['https://example.com/blog'] },
    ];

    expect(
      citedSources(documents, facts).map((entry) => entry.finalUrl),
    ).toEqual(['https://example.com/docs/', 'https://example.com/']);
  });
});
