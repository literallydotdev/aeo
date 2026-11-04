import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  cp,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readJournal } from '../bundle/journal';
import { openRecorder } from '../bundle/recorder';
import type { AeoAuditConfig } from '../schema';
import type { CapturedUnitRecord } from '../stores/ports';
import {
  createMemoryModelAccounting,
  ModelBudgetError,
} from '../models/accounting';
import { tokenCostUsd } from '../models/pricing';
import { testStageModelFixture } from '../models/profile-fixture';
import {
  canonicalizeQualifiedNames,
  mergeBatches,
  validateStage,
} from './checks';
import {
  applyCorrections,
  correctionValue,
  fieldPath,
  isStageFresh,
  partition,
  runStage,
  stageInputsDigest,
  type StageContext,
} from './stage';
import {
  stageSchemas,
  stageVersions,
  stageJsonSchema,
  type AnalyzeOutput,
  type QualifyOutput,
  type ReviewOutput,
  type StageName,
} from './schemas';
import { materializeWorkdir, type AnswerFile } from './workdir';
import { CopyVerificationUnavailableError } from './copy-recovery';

/** Parses JSON the runner wrote, as the shape the test checks. */
const parseJson = <T>(text: string): T => {
  return JSON.parse(text) as T;
};

const readJson = async <T>(file: string): Promise<T> => {
  return parseJson<T>(await readFile(file, 'utf8'));
};

/** The first item, which the test's own fixture guarantees. */
const firstOf = <T>(items: readonly T[]): T => {
  const [item] = items;

  if (item === undefined) {
    throw new Error('Expected at least one item.');
  }

  return item;
};

type CorrectionTrail = { by: string; outcome: string }[];

type JournalLine = { attempt: number; retrying?: boolean; errors: string[] };

type BatchPacket = {
  continuation: boolean;
  files: Record<string, unknown>;
  answers?: AnswerFile[];
  current: unknown;
  previous: ReviewOutput | null;
  hostFeedback?: { corrections: unknown[] };
};

// ============================================================================
// The stage runner against a fake `codex`: a shell script that behaves like
// the real CLI where it matters (reads stdin to EOF, streams JSON events,
// writes --output-last-message) and writes whatever output the test asks
// for. Nothing here exercises judgment; it is the host's half of §4.
// ============================================================================

const brand = { name: 'Deno Deploy', domain: 'deno.com', aliases: ['Deno'] };
const config = {
  brand,
  competitors: [{ name: 'Vercel', domain: 'vercel.com', aliases: [] }],
  sections: [
    {
      key: 'hosting',
      prompts: [{ id: 'h1', text: 'Where should I host a TypeScript API?' }],
    },
  ],
} as unknown as AeoAuditConfig;

const capturedAnswer = {
  status: 'captured',
  sectionKey: 'hosting',
  promptId: 'h1',
  promptText: 'Where should I host a TypeScript API?',
  surface: 'perplexity',
  runIndex: 1,
  probe: {
    text: 'Vercel is the common pick; Deno Deploy works too.\n\nSources used by search:\n- https://vercel.com/docs',
  },
} as unknown as CapturedUnitRecord;

const captured = [capturedAnswer];

const goodAnalyzeRow = {
  file: 'ANSWERS/hosting/h1/perplexity-1.md',
  prospectMentioned: true,
  prospectPosition: 'secondary',
  prospectSentiment: 'positive',
  contextSnippet: 'Deno Deploy works too.',
  competitorMentions: [
    { domain: 'vercel.com', mentioned: true, position: 'primary' },
  ],
  mentionedBrands: [
    { name: 'Vercel', domain: 'vercel.com' },
    { name: 'Deno Deploy', domain: 'deno.com' },
  ],
};

const goodAnalyze = { rows: [goodAnalyzeRow] };

/** A fake codex: consumes stdin (which must be closed by the runner or this
 * hangs), emits two events, then writes the Nth scripted output. */
const fakeCodex = async (
  dir: string,
  outputs: unknown[],
  {
    missingOutputAttempts = 0,
    missingOutputStderr = 'Reconnecting... 1/5 (stream disconnected before completion: idle timeout waiting for SSE)',
    usage = '{"input_tokens":120,"output_tokens":30}',
  }: {
    missingOutputAttempts?: number;
    missingOutputStderr?: string;
    usage?: string;
  } = {},
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
      `for a in "$@"; do LAST="$a"; done; if [ "$LAST" = "-" ]; then LAST=$(cat "${dir}/fake-stdin"); fi; OUT=$(printf "%s" "$LAST" | grep -o "OUT/[a-z]*/[0-9]*\\.json" | tail -1)`,
      `COUNT="${dir}/fake-attempts"`,
      'N=$(cat "$COUNT" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "$COUNT"',
      `if [ "$N" -le ${missingOutputAttempts} ]; then echo '${missingOutputStderr}' >&2; exit 0; fi`,
      `echo "$CODEX_HOME" > "${dir}/fake-codex-home"; env | sort > "${dir}/fake-codex-env"`,
      'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}\'',
      `echo '{"type":"turn.completed","usage":${usage}}'`,
      `node -e "const o=JSON.parse(require('fs').readFileSync('${outputsFile}','utf8'));require('fs').writeFileSync(process.argv[1], JSON.stringify(o[Math.min(${'$N'}-1,o.length-1)]))" "$OUT"`,
    ].join('\n'),
  );
  await chmod(script, 0o755);

  return script;
};

const workdir = async (): Promise<Omit<StageContext, 'command'>> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aeo-codex-'));
  const answers = await materializeWorkdir({
    dir,
    config,
    captured,
    copyRules: '# copy',
  });

  await mkdir(path.join(dir, 'JOURNAL'), { recursive: true });

  return {
    dir,
    brand,
    answers,
    stageModel: testStageModelFixture,
    timeoutMs: 20_000,
  };
};

describe('Stage - runStage()', () => {
  beforeAll(() => {
    // Never the operator's real key: the fake dumps its environment to disk.
    process.env.AI_GATEWAY_API_KEY = 'test-key';
  });

  it('should apply a checkpointed review correction after interruption before the stage merge', async () => {
    const ctx = await workdir();

    await mkdir(path.join(ctx.dir, 'OUT'), { recursive: true });
    await writeFile(
      path.join(ctx.dir, 'OUT/analyze.json'),
      JSON.stringify(goodAnalyze),
    );
    await writeFile(
      path.join(ctx.dir, 'OUT/qualify.json'),
      JSON.stringify({
        rows: [{ file: goodAnalyzeRow.file, qualifiedCompetitors: [] }],
        corrections: [],
      }),
    );

    const review = {
      verdict: 'accepted',
      criteria: [{ criterionId: 'competitor_omission', outcome: 'pass' }],
      unresolved: [],
      corrections: [
        {
          stage: 'analyze',
          file: goodAnalyzeRow.file,
          field: 'contextSnippet',
          from: JSON.stringify(goodAnalyzeRow.contextSnippet),
          to: JSON.stringify('Deno Deploy works too'),
          reason: 'Retain the evidence span',
        },
      ],
    };

    const command = await fakeCodex(ctx.dir, [review]);

    await expect(
      runStage(
        {
          ...ctx,
          command,
          checkpoint: (files) => {
            if (files?.includes('OUT/review/0.json')) {
              return Promise.reject(new Error('worker replaced before merge'));
            }

            return Promise.resolve();
          },
        },
        'review',
      ),
    ).rejects.toThrow('worker replaced before merge');
    expect(
      (await readJson<AnalyzeOutput>(path.join(ctx.dir, 'OUT/analyze.json')))
        .rows[0]?.contextSnippet,
    ).toBe(goodAnalyzeRow.contextSnippet);

    const resumed = await runStage({ ...ctx, command }, 'review');

    expect(resumed.summary).toMatchObject({ attempts: 0, corrections: 1 });
    expect(
      (await readJson<AnalyzeOutput>(path.join(ctx.dir, 'OUT/analyze.json')))
        .rows[0]?.contextSnippet,
    ).toBe('Deno Deploy works too');
  });

  it('should record each session and the host decision on its output in the run journal', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [{ rows: [] }, goodAnalyze]);
    const recorder = await openRecorder(ctx.dir, {
      origin: 'local',
      runId: 'run-1',
      measurementDigest: 'a'.repeat(64),
      planDigest: 'b'.repeat(64),
    });

    await runStage({ ...ctx, command, recorder }, 'analyze');
    await runStage({ ...ctx, command, recorder }, 'analyze');

    const events = readJournal(
      await readFile(path.join(ctx.dir, 'JOURNAL/run/events.jsonl'), 'utf8'),
    ).events;
    const types = events.map((event) => event.type);
    const accepted = events.find((event) => event.type === 'output_accepted');
    const sessions = events.filter(
      (event) => event.type === 'operation_started',
    );

    expect(types).toEqual([
      'run_started',
      'plan_frozen',
      'operation_started',
      'operation_finished',
      'output_refused',
      'operation_started',
      'operation_finished',
      'output_accepted',
      'artifact_reused',
    ]);
    expect(sessions.map((event) => event.payload.attempt)).toEqual([1, 2]);
    expect(accepted?.payload.operationId).toBe(sessions[1]?.operationId);
    expect(sessions[0]?.payload.details).toMatchObject({
      requestedModel: testStageModelFixture.model,
    });
  });

  it('should record every correction outcome as a host decision in the run journal', async () => {
    const ctx = await workdir();
    const recorder = await openRecorder(ctx.dir, {
      origin: 'local',
      runId: 'run-1',
      measurementDigest: 'a'.repeat(64),
      planDigest: 'b'.repeat(64),
    });

    await mkdir(path.join(ctx.dir, 'OUT'), { recursive: true });
    await writeFile(
      path.join(ctx.dir, 'OUT/analyze.json'),
      JSON.stringify(goodAnalyze),
    );
    const correction = {
      stage: 'analyze' as const,
      file: goodAnalyzeRow.file,
      field: 'contextSnippet',
      from: JSON.stringify(goodAnalyzeRow.contextSnippet),
      to: JSON.stringify('Deno Deploy works too'),
      reason: 'Retain the evidence span',
    };

    const result = await applyCorrections({ ...ctx, recorder }, 'review', [
      correction,
      { ...correction, file: 'ANSWERS/hosting/h1/not-an-answer.md' },
    ]);
    const types = readJournal(
      await readFile(path.join(ctx.dir, 'JOURNAL/run/events.jsonl'), 'utf8'),
    ).events.map((event) => event.type);

    expect(result).toEqual({ applied: 1, refused: 1 });
    expect(types.slice(-2)).toEqual([
      'correction_applied',
      'correction_refused',
    ]);
  });

  it('should run Codex in an isolated home inside the work directory with only the gateway key', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze]);
    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.ok).toBe(true);

    const home = (
      await readFile(path.join(ctx.dir, 'fake-codex-home'), 'utf8')
    ).trim();

    expect(home).toBe(path.join(ctx.dir, '.codex-home'));
    expect(
      await readFile(path.join(ctx.dir, 'fake-codex-env'), 'utf8'),
    ).toContain(`TMPDIR=${path.join(ctx.dir, '.tmp')}`);

    const config = await readFile(path.join(home, 'config.toml'), 'utf8');

    expect(config).toContain(`model = "${testStageModelFixture.model}"`);
    expect(config).toContain('base_url = "https://ai-gateway.vercel.sh/v1"');
    expect(config).toContain('wire_api = "responses"');
    // The gateway model has no Codex metadata; the window is pinned so the
    // session is not compacted at a default threshold.
    expect(config).toContain('model_context_window = 1000000');
    expect(config).toContain('project_doc_max_bytes = 0');
    expect(config).toContain('project_root_markers = [".aeo-report-root"]');
    expect(config).toContain(
      '[features]\nplugins = false\nremote_plugin = false',
    );
    // The test work directory lives under /tmp, where the exclusion would
    // exclude the work directory itself; elsewhere /tmp is excluded.
    expect(config).not.toContain('exclude_slash_tmp');

    const { codexConfigToml } = await import('./codex-home');

    expect(
      codexConfigToml('/srv/aeo/run', { stageModel: testStageModelFixture }),
    ).toContain('exclude_slash_tmp = true');

    const env = (await readFile(path.join(ctx.dir, 'fake-codex-env'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=')[0]);

    expect(env).toEqual(
      expect.arrayContaining([
        'AI_GATEWAY_API_KEY',
        'CODEX_HOME',
        'HOME',
        'PATH',
      ]),
    );

    // Nothing of the host's environment beyond what the shell itself adds.
    for (const name of [
      'AEO_DATABASE_URL',
      'AEO_MODEL_PROFILE',
      'CODEX_AUTH_JSON',
      'USER',
      'LANG',
    ]) {
      expect(env).not.toContain(name);
    }
  });

  it('should refuse to start without the gateway key', async () => {
    const ctx = await workdir();
    const { prepareCodexHome } = await import('./codex-home');

    await expect(
      prepareCodexHome(ctx.dir, {
        stageModel: testStageModelFixture,
        env: { PATH: '/bin' },
      }),
    ).rejects.toThrow(/AI_GATEWAY_API_KEY is not set/);
  });

  it("should settle each session on the ledger from its input, cached input and output tokens at the stage model's prices", async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze], {
      usage:
        '{"input_tokens":120000,"cached_input_tokens":100000,"output_tokens":3000}',
    });
    const accounting = createMemoryModelAccounting({
      maxUsd: 100,
      maxTokens: 100_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });

    await runStage({ ...ctx, command, accounting }, 'analyze');

    const calls = Object.values(accounting.state.calls);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.role).toBe('stage:analyze');
    expect(calls[0]?.usage).toEqual({
      requestedModel: testStageModelFixture.model,
      costUsd: tokenCostUsd(testStageModelFixture.pricingUsdPerMillion, {
        inputTokens: 120_000,
        cachedInputTokens: 100_000,
        outputTokens: 3000,
      }),
      inputTokens: 120_000,
      cachedInputTokens: 100_000,
      outputTokens: 3000,
    });
  });

  it('should NOT start a session the cap cannot afford, and stop the stage on the budget', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze]);
    const accounting = createMemoryModelAccounting({
      maxUsd: 0.01,
      maxTokens: 100_000_000,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });

    const result = runStage({ ...ctx, command, accounting }, 'analyze');

    await expect(result).rejects.toThrow(ModelBudgetError);
    await expect(
      readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
    expect(Object.keys(accounting.state.calls)).toEqual([]);
  });

  it('should deliver complete batch input and close stdin before waiting for output', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze]);
    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.errors).toEqual([]);
    expect(run.ok).toBe(true);
    expect(run.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 30,
    });
    expect(run.summary).toEqual({
      batches: 1,
      reused: 0,
      attempts: 1,
      refusals: 0,
      rows: 1,
    });

    const events = await readFile(
      path.join(ctx.dir, 'JOURNAL', 'analyze-0.events.jsonl'),
      'utf8',
    );

    expect(events.split('\n').filter(Boolean)).toHaveLength(3);

    const digest = await readFile(
      path.join(ctx.dir, 'OUT', 'analyze.inputs.sha'),
      'utf8',
    );

    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const input = await readJson<BatchPacket & { current: { file: string }[] }>(
      path.join(ctx.dir, 'fake-stdin'),
    );

    expect(input.answers).toEqual(ctx.answers);
    expect(input.current.map((entry) => entry.file)).toEqual(
      ctx.answers.map((answer) => answer.file),
    );
    expect(input.files['CONFIG.json']).toHaveProperty('brand', brand);
    expect(input.files['RULES/analysis.md']).toContain('Positions');
    expect(input.files['CRITERIA.md']).toContain('Reviewer criteria');
    expect(input.files['SCHEMA/analyze.json']).toEqual(
      stageJsonSchema('analyze'),
    );
    expect(input.continuation).toBe(false);
  });

  it('should deliver evidence larger than an OS argument without truncating its tail', async () => {
    const ctx = await workdir();
    const body = `${'Repeated answer detail. '.repeat(12_000)}Deno Deploy works too.`;
    const answers = [{ ...firstOf(ctx.answers), body }];
    const run = await runStage(
      { ...ctx, answers, command: await fakeCodex(ctx.dir, [goodAnalyze]) },
      'analyze',
    );

    expect(run.ok).toBe(true);

    const input = await readJson<BatchPacket>(path.join(ctx.dir, 'fake-stdin'));

    expect(input.answers?.[0]?.body).toBe(body);
    expect(
      await readFile(path.join(ctx.dir, 'fake-args'), 'utf8'),
    ).not.toContain(body);
  });

  it("should archive the previous run's notes before a stage reruns", async () => {
    const ctx = await workdir();

    await writeFile(
      path.join(ctx.dir, 'JOURNAL', 'analyze-0.md'),
      '# old notes',
    );
    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [goodAnalyze]) },
      'analyze',
    );

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(path.join(ctx.dir, 'JOURNAL'));

    expect(files.some((file) => /^analyze-0\.\d{4}-.*\.md$/.test(file))).toBe(
      true,
    );
    expect(files).not.toContain('analyze-0.md');
  });

  it('should feed a refused output back once and accept the corrected second attempt', async () => {
    const ctx = await workdir();
    const missingRow = {
      rows: [{ ...goodAnalyzeRow, file: 'ANSWERS/hosting/h1/nope-1.md' }],
    };
    const command = await fakeCodex(ctx.dir, [missingRow, goodAnalyze]);
    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.ok).toBe(true);
    expect(await readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8')).toBe(
      '2\n',
    );

    // The refusal's reasons survive the accepted retry, in the journal.
    const refusals = (
      await readFile(
        path.join(ctx.dir, 'JOURNAL', 'analyze-0.refusals.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => parseJson<JournalLine>(line));

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.attempt).toBe(1);
    expect(refusals[0]?.errors.join(' ')).toContain('no row');
  });

  it('should retry a successful CLI exit without output instead of dropping its answers', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze], {
      missingOutputAttempts: 1,
    });
    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.ok).toBe(true);
    expect(run.degraded).toEqual([]);
    expect(run.errors).toEqual([]);
    expect(run.summary).toMatchObject({ attempts: 2, refusals: 0, rows: 1 });

    const failures = (
      await readFile(
        path.join(ctx.dir, 'JOURNAL', 'analyze-0.failures.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => parseJson<JournalLine>(line));

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ attempt: 1, retrying: true });
    expect(failures[0]?.errors[0]).toContain('without an output file');
    expect(failures[0]?.errors[0]).toContain('idle timeout waiting for SSE');
  });

  it('should stop after one session and report auth when the provider rejects the credential', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze], {
      missingOutputAttempts: 3,
      missingOutputStderr:
        'unexpected status 401 Unauthorized: Authentication failed. Check that your Vercel credential is valid and has access to AI Gateway.',
    });

    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.fatal).toBe('auth');
    expect(run.errors[0]).toContain('401 Unauthorized');

    const failures = (
      await readFile(
        path.join(ctx.dir, 'JOURNAL', 'analyze-0.failures.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => parseJson<JournalLine>(line));

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ attempt: 1, retrying: false });
  });

  it('should kill a timed-out CLI descendant after its launcher exits and retry the unfinished batch', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze], {
      missingOutputAttempts: 1,
    });
    const script = await readFile(command, 'utf8');

    await writeFile(
      command,
      script.replace(
        /echo 'Reconnecting[^\n]+; exit 0; fi/,
        `node -e "setTimeout(() => {}, 2500)" & echo $! > "${ctx.dir}/fake-descendant"; exit 0; fi`,
      ),
    );

    const run = await runStage({ ...ctx, command, timeoutMs: 300 }, 'analyze');
    // The descendant held the launcher's stdout; it is gone with its group.
    const descendant = Number(
      await readFile(path.join(ctx.dir, 'fake-descendant'), 'utf8'),
    );

    await vi.waitFor(() => expect(() => process.kill(descendant, 0)).toThrow());
    expect(run.ok).toBe(true);
    expect(run.degraded).toEqual([]);
    expect(run.summary).toMatchObject({ attempts: 2, rows: 1 });
    expect(
      await readFile(
        path.join(ctx.dir, 'JOURNAL/analyze-0.failures.jsonl'),
        'utf8',
      ),
    ).toContain('session exceeded');
  });

  it('should retry a nonzero CLI exit without dropping the batch answers', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze], {
      missingOutputAttempts: 1,
    });

    await writeFile(
      command,
      (await readFile(command, 'utf8')).replace('exit 0; fi', 'exit 7; fi'),
    );

    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.degraded).toEqual([]);
    expect(run.summary).toMatchObject({ attempts: 2, rows: 1 });
  });

  it('should never judge a session that wrote nothing on the refused file of the attempt before', async () => {
    const ctx = await workdir();
    const missingRow = {
      rows: [{ ...goodAnalyzeRow, file: 'ANSWERS/hosting/h1/nope-1.md' }],
    };
    const command = await fakeCodex(ctx.dir, [missingRow, goodAnalyze]);

    await writeFile(
      command,
      (await readFile(command, 'utf8')).replace('"$N" -le 0', '"$N" -eq 2'),
    );

    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.ok).toBe(true);
    // Attempt 1 refused, attempt 2 wrote nothing, attempt 3 accepted.
    expect(run.summary).toMatchObject({ attempts: 3, refusals: 1, rows: 1 });
    expect(
      JSON.parse(
        await readFile(
          path.join(ctx.dir, 'OUT/analyze/0.refused.json'),
          'utf8',
        ),
      ),
    ).toEqual(missingRow);
    expect(
      await readFile(
        path.join(ctx.dir, 'JOURNAL/analyze-0.failures.jsonl'),
        'utf8',
      ),
    ).toContain('without an output file');
  });

  it('should record a missing executable as bounded degraded work without crashing the host', async () => {
    const ctx = await workdir();
    const run = await runStage(
      { ...ctx, command: path.join(ctx.dir, 'missing-codex') },
      'analyze',
    );

    expect(run.ok).toBe(true);
    expect(run.summary).toMatchObject({ attempts: 3, degraded: 1 });
    expect(run.errors.join(' ')).toContain('ENOENT');
  });

  it('should retain a valid completed output when the CLI exits nonzero afterward', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze]);

    await writeFile(command, `${await readFile(command, 'utf8')}\nexit 7\n`);

    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.degraded).toEqual([]);
    expect(run.summary).toMatchObject({ attempts: 1, rows: 1 });
  });

  it('should bound missing-output retries and record the uncovered answers when none succeeds', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [goodAnalyze], {
      missingOutputAttempts: 3,
    });
    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.ok).toBe(true);
    expect(
      JSON.parse(
        await readFile(path.join(ctx.dir, 'OUT/analyze.json'), 'utf8'),
      ),
    ).toEqual({ rows: [] });
    expect(run.summary).toMatchObject({
      attempts: 3,
      refusals: 0,
      degraded: 1,
    });
    expect(run.degraded).toEqual(['ANSWERS/hosting/h1/perplexity-1.md']);
    expect(await readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8')).toBe(
      '3\n',
    );
  });

  it('should preserve measurement delivery when no batch judgment validates', async () => {
    const ctx = await workdir();
    const bad = {
      rows: [{ ...goodAnalyzeRow, file: 'ANSWERS/hosting/h1/nope-1.md' }],
    };
    const command = await fakeCodex(ctx.dir, [bad, bad, bad]);
    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.ok).toBe(true);
    expect(run.degraded).toEqual(['ANSWERS/hosting/h1/perplexity-1.md']);
    expect(run.summary).toMatchObject({
      batches: 1,
      attempts: 3,
      refusals: 3,
      degraded: 1,
    });
    expect(run.errors).toContain(
      'batch 0: ANSWERS/hosting/h1/perplexity-1.md: no row',
    );
    expect(await readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8')).toBe(
      '3\n',
    );
    expect(run.model).toBe(testStageModelFixture.model);
  });

  it("should apply a later stage's corrections to the earlier OUT file and keep the trail", async () => {
    const ctx = await workdir();

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [goodAnalyze]) },
      'analyze',
    );

    const qualify = {
      rows: [
        {
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          qualifiedCompetitors: [
            {
              name: 'Vercel',
              domain: 'vercel.com',
              quote: 'Vercel is the common pick',
            },
          ],
        },
      ],
      corrections: [
        {
          stage: 'analyze',
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          field: 'prospectPosition',
          from: '"secondary"',
          to: '"listed"',
          reason: 'named after the recommendation, not as an alternative',
        },
      ],
    };

    const run = await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [qualify]) },
      'qualify',
    );

    expect(run.errors).toEqual([]);

    const analyze = await readJson<AnalyzeOutput>(
      path.join(ctx.dir, 'OUT', 'analyze.json'),
    );

    expect(analyze.rows[0]?.prospectPosition).toBe('listed');

    const trail = await readJson<CorrectionTrail>(
      path.join(ctx.dir, 'OUT', 'corrections.json'),
    );

    expect(trail).toHaveLength(1);
    expect(trail[0]?.by).toBe('qualify');
    expect(trail[0]?.outcome).toBe('applied');
  });

  it('should apply a nested review correction and restore source formatting without refusing it', async () => {
    const ctx = await workdir();

    ctx.answers = ctx.answers.map((answer) => ({
      ...answer,
      body: answer.body.replace('Vercel', '**Vercel**'),
    }));
    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [goodAnalyze]) },
      'analyze',
    );

    const qualify = {
      rows: [
        {
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          qualifiedCompetitors: [
            {
              name: 'Vercel',
              domain: 'vercel.com',
              quote: 'Deno Deploy works too',
            },
          ],
        },
      ],
      corrections: [],
    };

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [qualify]) },
      'qualify',
    );

    const review = {
      verdict: 'accepted',
      criteria: [{ criterionId: 'competitor_omission', outcome: 'pass' }],
      corrections: [
        {
          stage: 'qualify',
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          field: 'qualifiedCompetitors[0].quote',
          from: '"Deno Deploy works too"',
          to: '"Vercel is the common pick"',
          reason: 'the quote never names Vercel',
        },
      ],
      unresolved: [],
    };

    const run = await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [review]) },
      'review',
    );

    expect(run.summary).toMatchObject({ corrections: 1, verdict: 'accepted' });

    const stored = await readJson<QualifyOutput>(
      path.join(ctx.dir, 'OUT', 'qualify.json'),
    );

    expect(stored.rows[0]?.qualifiedCompetitors[0]?.quote).toBe(
      '**Vercel** is the common pick',
    );
  });

  it('should leave the file untouched when the rules reverse only part of a correction', async () => {
    const ctx = await workdir();
    const absentRow = {
      rows: [
        {
          ...goodAnalyzeRow,
          prospectMentioned: false,
          prospectPosition: 'absent',
          contextSnippet: '',
          mentionedBrands: [{ name: 'Vercel', domain: 'vercel.com' }],
        },
      ],
    };

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [absentRow]) },
      'analyze',
    );

    const qualify = {
      rows: [
        {
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          qualifiedCompetitors: [],
        },
      ],
      corrections: [
        {
          stage: 'analyze',
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          field: 'mentionedBrands',
          from: '[{"name":"Vercel","domain":"vercel.com"}]',
          // Render would be a valid addition; Deno is the prospect and gets dropped.
          to: '[{"name":"Vercel","domain":"vercel.com"},{"name":"Render","domain":"render.com"},{"name":"Deno","domain":"deno.com"}]',
          reason: 'the body names Render and Deno',
        },
      ],
    };

    const run = await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [qualify]) },
      'qualify',
    );

    expect(run.summary).toMatchObject({
      corrections: 0,
      refusedCorrections: 1,
    });

    const analyze = await readJson<AnalyzeOutput>(
      path.join(ctx.dir, 'OUT', 'analyze.json'),
    );

    expect(analyze.rows[0]?.mentionedBrands).toEqual([
      { name: 'Vercel', domain: 'vercel.com' },
    ]);
  });

  it('should stay fresh on the next run after its own corrections changed the upstream file', async () => {
    const ctx = await workdir();

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [goodAnalyze]) },
      'analyze',
    );

    const qualify = {
      rows: [
        {
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          qualifiedCompetitors: [],
        },
      ],
      corrections: [
        {
          stage: 'analyze',
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          field: 'prospectPosition',
          from: '"secondary"',
          to: '"listed"',
          reason: 'named after the recommendation',
        },
      ],
    };

    const run = await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [qualify]) },
      'qualify',
    );

    expect(run.summary).toMatchObject({ corrections: 1 });
    expect(await isStageFresh(ctx, 'qualify')).toBe(true);
  });

  it('should reuse qualification after review corrects an analyzed evidence snippet', async () => {
    const ctx = await workdir();

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [goodAnalyze]) },
      'analyze',
    );

    const qualify = {
      rows: [{ file: goodAnalyzeRow.file, qualifiedCompetitors: [] }],
      corrections: [
        {
          stage: 'analyze',
          file: goodAnalyzeRow.file,
          field: 'prospectPosition',
          from: '"secondary"',
          to: '"listed"',
          reason: 'Initially treated as a list entry',
        },
      ],
    };

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [qualify]) },
      'qualify',
    );

    const review = {
      verdict: 'accepted',
      criteria: [{ criterionId: 'competitor_omission', outcome: 'pass' }],
      corrections: [
        {
          stage: 'analyze',
          file: goodAnalyzeRow.file,
          field: 'contextSnippet',
          from: JSON.stringify(goodAnalyzeRow.contextSnippet),
          to: JSON.stringify('Deno Deploy works too'),
          reason: 'Keep the exact evidence span',
        },
        {
          stage: 'analyze',
          file: goodAnalyzeRow.file,
          field: 'prospectPosition',
          from: '"listed"',
          to: '"secondary"',
          reason: 'It is an alternative after the primary recommendation',
        },
      ],
      unresolved: [],
    };

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [review]) },
      'review',
    );
    expect(await isStageFresh(ctx, 'analyze')).toBe(true);
    expect(await isStageFresh(ctx, 'qualify')).toBe(true);
    expect(await isStageFresh(ctx, 'review')).toBe(true);

    const resumed = await runStage(
      { ...ctx, command: '/does-not-exist' },
      'qualify',
    );

    expect(resumed.summary).toMatchObject({
      reused: 1,
      attempts: 0,
      corrections: 0,
    });
    await runStage({ ...ctx, command: '/does-not-exist' }, 'analyze');

    const analyzed = await readJson<AnalyzeOutput>(
      path.join(ctx.dir, 'OUT', 'analyze.json'),
    );

    expect(analyzed.rows[0]).toMatchObject({
      contextSnippet: 'Deno Deploy works too',
      prospectPosition: 'secondary',
    });

    const clean = { ...review, corrections: [] };

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [clean]) },
      'review',
      { force: true },
    );

    const resumedInput = await readFile(
      path.join(ctx.dir, 'fake-stdin'),
      'utf8',
    );

    expect(resumedInput).toContain('Continue the same review');

    const continued = parseJson<
      BatchPacket & { current: { analyze: unknown[] } }
    >(resumedInput.split('\n').at(-1) ?? 'null');

    expect(continued.continuation).toBe(true);
    expect(continued.files).toEqual({});
    expect(continued.answers).toBeUndefined();
    expect(continued.previous?.corrections).toEqual(review.corrections);
    expect(continued.current.analyze[0]).toMatchObject(firstOf(analyzed.rows));
    expect(await readFile(path.join(ctx.dir, 'fake-args'), 'utf8')).toContain(
      'resume',
    );
    expect(
      (await readFile(path.join(ctx.dir, 'fake-args'), 'utf8')).trimEnd(),
    ).toMatch(/resume\n[^\n]+\n-$/);
  });

  it('should supply refused review proposals as actionable feedback in the retained session', async () => {
    const ctx = await workdir();

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [goodAnalyze]) },
      'analyze',
    );
    await runStage(
      {
        ...ctx,
        command: await fakeCodex(ctx.dir, [
          {
            rows: [
              { file: firstOf(ctx.answers).file, qualifiedCompetitors: [] },
            ],
            corrections: [],
          },
        ]),
      },
      'qualify',
    );

    const proposed = {
      stage: 'analyze',
      file: firstOf(ctx.answers).file,
      field: 'mentionedBrands',
      from: JSON.stringify(goodAnalyzeRow.mentionedBrands),
      to: JSON.stringify({ name: 'Vercel', domain: 'vercel.com' }),
      reason: 'An invalid object proposed for an array field',
    };

    const review = {
      verdict: 'accepted',
      criteria: [],
      corrections: [proposed],
      unresolved: [],
    };

    const first = await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [review]) },
      'review',
    );

    expect(first.summary.refusedCorrections).toBe(1);
    await runStage(
      {
        ...ctx,
        command: await fakeCodex(ctx.dir, [{ ...review, corrections: [] }]),
      },
      'review',
      { force: true },
    );

    const input = parseJson<
      BatchPacket & {
        current: { analyze: { mentionedBrands: unknown }[] };
      }
    >(
      (await readFile(path.join(ctx.dir, 'fake-stdin'), 'utf8'))
        .split('\n')
        .at(-1) ?? 'null',
    );

    expect(input.continuation).toBe(true);
    expect(input.previous?.corrections).toEqual([]);
    expect(input.hostFeedback?.corrections).toEqual([
      expect.objectContaining({
        ...proposed,
        outcome: expect.stringContaining('expected array') as unknown,
      }),
    ]);
    expect(input.current.analyze[0]?.mentionedBrands).toEqual(
      goodAnalyzeRow.mentionedBrands,
    );
  });

  it('should start a fresh conversation after a resumed one produces nothing, and after a stage version bump', async () => {
    const ctx = await workdir();

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [goodAnalyze]) },
      'analyze',
    );
    await runStage(
      {
        ...ctx,
        command: await fakeCodex(ctx.dir, [
          {
            rows: [
              { file: firstOf(ctx.answers).file, qualifiedCompetitors: [] },
            ],
            corrections: [],
          },
        ]),
      },
      'qualify',
    );

    // A pass with a correction, so a forced rerun is not simply reused.
    const review = {
      verdict: 'accepted',
      criteria: [],
      corrections: [
        {
          stage: 'analyze',
          file: firstOf(ctx.answers).file,
          field: 'contextSnippet',
          from: JSON.stringify(goodAnalyzeRow.contextSnippet),
          to: JSON.stringify('Deno Deploy works too'),
          reason: 'Keep the exact evidence span',
        },
      ],
      unresolved: [],
    };

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [review]) },
      'review',
    );

    const argsFile = path.join(ctx.dir, 'fake-args');
    const resumes = async () => {
      return (await readFile(argsFile, 'utf8'))
        .split('\n')
        .filter((arg) => arg === 'resume').length;
    };

    // Attempt 4 resumes the saved conversation and writes nothing; attempt
    // 5 starts fresh and is accepted.
    await writeFile(argsFile, '');

    const run = await runStage(
      {
        ...ctx,
        command: await fakeCodex(ctx.dir, [review], {
          missingOutputAttempts: 4,
        }),
      },
      'review',
      { force: true },
    );

    expect(run.ok).toBe(true);
    expect(run.summary).toMatchObject({ attempts: 2 });
    expect(await resumes()).toBe(1);
    await writeFile(argsFile, '');

    const version = stageVersions.review;

    stageVersions.review = version + 1;

    try {
      await runStage(
        { ...ctx, command: await fakeCodex(ctx.dir, [review]) },
        'review',
        { force: true },
      );
      expect(await resumes()).toBe(0);
    } finally {
      stageVersions.review = version;
    }
  });

  it('should apply review corrections to the rows of answers a later batch degraded', async () => {
    const ctx = await workdir();
    const judged = firstOf(ctx.answers);
    const degraded = {
      ...judged,
      file: 'ANSWERS/hosting/h1/chatgpt-1.md',
      surface: 'chatgpt',
    };

    await mkdir(path.join(ctx.dir, 'OUT'), { recursive: true });
    await writeFile(
      path.join(ctx.dir, 'OUT/analyze.json'),
      JSON.stringify({
        rows: [goodAnalyzeRow, { ...goodAnalyzeRow, file: degraded.file }],
      }),
    );

    const correction = (file: string) => {
      return {
        stage: 'analyze' as const,
        file,
        field: 'prospectPosition',
        from: '"secondary"',
        to: '"listed"',
        reason: 'named after the recommendation',
      };
    };

    // The qualify batch of the second answer degraded, so the review judges
    // only the first; both rows exist, so both corrections apply.
    expect(
      await applyCorrections(
        {
          dir: ctx.dir,
          brand,
          answers: [judged],
          allAnswers: [judged, degraded],
        },
        'review',
        [correction(judged.file), correction(degraded.file)],
      ),
    ).toEqual({ applied: 2, refused: 0 });
  });

  it('should refuse a correction the host rules reverse and record why', async () => {
    const ctx = await workdir();
    const absentRow = {
      rows: [
        {
          ...goodAnalyzeRow,
          prospectMentioned: false,
          prospectPosition: 'absent',
          contextSnippet: '',
        },
      ],
    };

    await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [absentRow]) },
      'analyze',
    );

    const qualify = {
      rows: [
        {
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          qualifiedCompetitors: [],
        },
      ],
      corrections: [
        {
          stage: 'analyze',
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          field: 'mentionedBrands',
          from: '[{"name":"Vercel","domain":"vercel.com"}]',
          to: '[{"name":"Vercel","domain":"vercel.com"},{"name":"Deno","domain":"deno.com"}]',
          reason: 'the body names Deno as a runtime',
        },
      ],
    };

    const run = await runStage(
      { ...ctx, command: await fakeCodex(ctx.dir, [qualify]) },
      'qualify',
    );

    expect(run.ok).toBe(true);
    expect(run.summary).toEqual({
      batches: 1,
      reused: 0,
      attempts: 1,
      refusals: 0,
      rows: 1,
      corrections: 0,
      refusedCorrections: 1,
    });

    const analyze = await readJson<AnalyzeOutput>(
      path.join(ctx.dir, 'OUT', 'analyze.json'),
    );

    expect(
      analyze.rows[0]?.mentionedBrands.map((b: { name: string }) => b.name),
    ).toEqual(['Vercel']);

    const trail = await readJson<CorrectionTrail>(
      path.join(ctx.dir, 'OUT', 'corrections.json'),
    );

    expect(trail[0]?.outcome).toBe('refused: the host rules reverse it');
  });
});

describe('Stage - runStage() for the write stage', () => {
  const draft = {
    hero: {
      title: {
        kind: 'narrative',
        text: 'Deno Deploy shows up in half the answers.',
        basisFactIds: ['f1'],
        premises: [
          { proposition: 'half the answers name it', basisFactIds: ['f1'] },
        ],
      },
      subtitle: {
        kind: 'narrative',
        text: 'Vercel leads the field.',
        basisFactIds: ['f2'],
        premises: [
          { proposition: 'Vercel is named most', basisFactIds: ['f2'] },
        ],
      },
    },
    intro: [
      {
        kind: 'narrative',
        text: 'The audit measured hosting answers.',
        basisFactIds: ['f1'],
        premises: [
          { proposition: 'answers were measured', basisFactIds: ['f1'] },
        ],
      },
    ],
    sections: { hosting: { subtitle: [] } },
    confidence: 0.8,
  };

  it('should run one session, ask the host for its verdict, and keep the validated copy with the draft', async () => {
    const ctx = await workdir();
    const asked: unknown[] = [];
    const run = await runStage(
      {
        ...ctx,
        command: await fakeCodex(ctx.dir, [draft]),
        validateCopy: (candidate) => {
          asked.push(candidate);

          return Promise.resolve({
            ok: true,
            fixable: false,
            errors: [],
            payload: {
              copy: { intro: 'x' },
              outcome: 'valid',
              confidence: 0.8,
            },
          });
        },
      },
      'write',
    );

    expect(run.errors).toEqual([]);
    expect(run.summary).toMatchObject({
      batches: 1,
      attempts: 1,
      confidence: 0.8,
      outcome: 'valid',
    });
    expect(asked).toHaveLength(1);

    const stored = await readJson<{
      copy: unknown;
      draft: { confidence: number };
    }>(path.join(ctx.dir, 'OUT', 'write.json'));

    expect(stored.copy).toEqual({ intro: 'x' });
    expect(stored.draft.confidence).toBe(0.8);
  });

  it('should let the verifier repair a missing section without calling the implementer again', async () => {
    const ctx = await workdir();
    let asked = 0;
    const run = await runStage(
      {
        ...ctx,
        command: await fakeCodex(ctx.dir, [
          { ...draft, sections: {} },
          { ...draft, sections: {} },
          { ...draft, sections: {} },
        ]),
        validateCopy: (candidate) => {
          asked += 1;

          if (asked === 1) {
            return Promise.resolve({
              ok: false,
              fixable: true,
              errors: ['sections: hosting is missing'],
              editedDraft: draft,
            });
          }

          expect(candidate).toEqual(draft);

          return Promise.resolve({
            ok: true,
            fixable: false,
            errors: [],
            payload: { outcome: 'valid' },
          });
        },
      },
      'write',
    );

    expect(run.ok).toBe(true);
    expect(asked).toBe(2);
    expect(await readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8')).toBe(
      '1\n',
    );
  });

  it('should hand an existing copy directly to the verifier for requested edits', async () => {
    const ctx = await workdir();
    let checks = 0;
    const changed = { ...draft, confidence: 0.9 };
    const result = await runStage(
      {
        ...ctx,
        initialCopyDraft: draft,
        command: '/missing-implementer',
        validateCopy: (candidate) => {
          checks += 1;

          if (checks === 1) {
            return Promise.resolve({
              ok: false,
              fixable: true,
              errors: ['Requested edit'],
              editedDraft: changed,
            });
          }

          expect(candidate).toEqual(changed);

          return Promise.resolve({
            ok: true,
            fixable: false,
            errors: [],
            payload: { outcome: 'valid' },
          });
        },
      },
      'write',
    );

    expect(result.ok).toBe(true);
    expect(checks).toBe(2);
  });

  it('should revise defective copy and recheck the same draft when its verifier is unavailable', async () => {
    const ctx = await workdir();
    let calls = 0;
    const fixable = await runStage(
      {
        ...ctx,
        command: await fakeCodex(ctx.dir, [draft, draft]),
        validateCopy: () => {
          calls += 1;

          return Promise.resolve(
            calls === 1
              ? {
                  ok: false,
                  fixable: true,
                  errors: ['intro: banned word (banlist)'],
                  editedDraft: draft,
                }
              : {
                  ok: true,
                  fixable: false,
                  errors: [],
                  payload: { outcome: 'valid', confidence: 0.5 },
                },
          );
        },
      },
      'write',
    );

    expect(fixable.ok).toBe(true);
    expect(fixable.summary).toMatchObject({ attempts: 2, refusals: 1 });
    expect(await readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8')).toBe(
      '1\n',
    );

    const other = await workdir();
    let unavailableChecks = 0;
    const command = await fakeCodex(other.dir, [draft, draft, draft]);

    await expect(
      runStage(
        {
          ...other,
          command,
          validateCopy: () => {
            unavailableChecks += 1;

            return Promise.resolve({
              ok: false,
              fixable: false,
              errors: ['verifier_unavailable'],
            });
          },
        },
        'write',
      ),
    ).rejects.toBeInstanceOf(CopyVerificationUnavailableError);
    expect(unavailableChecks).toBe(3);
    expect(
      JSON.parse(
        await readFile(path.join(other.dir, 'PENDING/write-0.json'), 'utf8'),
      ),
    ).toMatchObject({
      rounds: 0,
      draft,
    });
    expect(await readFile(path.join(other.dir, 'fake-attempts'), 'utf8')).toBe(
      '1\n',
    );

    const recovered = await runStage(
      {
        ...other,
        command,
        validateCopy: () =>
          Promise.resolve({
            ok: true,
            fixable: false,
            errors: [],
            payload: { outcome: 'valid' },
          }),
      },
      'write',
    );

    expect(recovered.ok).toBe(true);
    expect(recovered.summary).toMatchObject({ attempts: 1, refusals: 0 });
    expect(await readFile(path.join(other.dir, 'fake-attempts'), 'utf8')).toBe(
      '1\n',
    );
  });

  it('should NOT burn editorial rounds retrying an exhausted budget', async () => {
    const ctx = await workdir();
    let checks = 0;

    await expect(
      runStage(
        {
          ...ctx,
          command: await fakeCodex(ctx.dir, [draft]),
          validateCopy: () => {
            checks += 1;

            return Promise.resolve({
              ok: false,
              fixable: false,
              outcome: 'budget_exhausted',
              errors: ['model_budget_exhausted'],
            });
          },
        },
        'write',
      ),
    ).rejects.toMatchObject({ outcome: 'budget_exhausted' });
    expect(checks).toBe(1);
    expect(
      JSON.parse(
        await readFile(path.join(ctx.dir, 'PENDING/write-0.json'), 'utf8'),
      ),
    ).toMatchObject({ rounds: 0, draft });
    await expect(
      readFile(path.join(ctx.dir, 'JOURNAL/write-0.refusals.jsonl'), 'utf8'),
    ).rejects.toThrow();
  });

  it('should resume a legacy draft after five blocked checks without recalling the writer', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [draft]);

    await expect(
      runStage(
        {
          ...ctx,
          command,
          validateCopy: () => Promise.reject(new Error('worker lost')),
        },
        'write',
      ),
    ).rejects.toThrow('worker lost');

    const file = path.join(ctx.dir, 'PENDING/write-0.json');
    const pending = await readJson<{
      version?: number;
      rounds: number;
      errors: string[];
    }>(file);

    delete pending.version;
    pending.rounds = 5;
    pending.errors = [
      'draft: Verification unavailable (model_budget_exhausted)',
    ];
    await writeFile(file, JSON.stringify(pending));
    await writeFile(
      path.join(ctx.dir, 'JOURNAL/write-0.refusals.jsonl'),
      Array.from({ length: 5 }, (_, index) =>
        JSON.stringify({ attempt: index + 1, errors: pending.errors }),
      ).join('\n'),
    );

    const resumed = await runStage(
      {
        ...ctx,
        command,
        validateCopy: (candidate, options) => {
          expect(candidate).toEqual(draft);
          expect(options?.round).toBe(1);
          expect(options?.previousFindings).toEqual([]);

          return Promise.resolve({
            ok: true,
            fixable: false,
            errors: [],
            payload: { outcome: 'valid' },
          });
        },
      },
      'write',
    );

    expect(resumed.ok).toBe(true);
    expect(resumed.summary).toMatchObject({ attempts: 1, refusals: 0 });
    expect(await readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8')).toBe(
      '1\n',
    );
  });

  it('should retry incomplete copy sessions without consuming draft review rounds', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [draft], {
      missingOutputAttempts: 2,
    });
    const result = await runStage(
      {
        ...ctx,
        command,
        validateCopy: () =>
          Promise.resolve({
            ok: true,
            fixable: false,
            errors: [],
            payload: { outcome: 'valid' },
          }),
      },
      'write',
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ attempts: 1, refusals: 0 });
    expect(await readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8')).toBe(
      '3\n',
    );

    const unavailable = await workdir();

    await expect(
      runStage(
        {
          ...unavailable,
          command: await fakeCodex(unavailable.dir, [draft], {
            missingOutputAttempts: 9,
          }),
          validateCopy: () =>
            Promise.resolve({ ok: true, fixable: false, errors: [] }),
        },
        'write',
      ),
    ).rejects.toThrow('without an output file');
    expect(
      await readFile(path.join(unavailable.dir, 'fake-attempts'), 'utf8'),
    ).toBe('3\n');
  });

  it('should resume the saved draft under verifier ownership after worker replacement', async () => {
    const ctx = await workdir();
    const command = await fakeCodex(ctx.dir, [draft, draft]);

    await expect(
      runStage(
        {
          ...ctx,
          command,
          validateCopy: () => Promise.reject(new Error('worker lost')),
        },
        'write',
      ),
    ).rejects.toThrow('worker lost');

    const replacement = await workdir();

    for (const directory of ['PENDING', 'JOURNAL', '.codex-home']) {
      await cp(
        path.join(ctx.dir, directory),
        path.join(replacement.dir, directory),
        { recursive: true },
      );
    }

    let checks = 0;
    const resumed = await runStage(
      {
        ...replacement,
        command,
        validateCopy: () => {
          checks += 1;

          return Promise.resolve(
            checks === 1
              ? {
                  ok: false,
                  fixable: true,
                  errors: ['Repair the unsupported headline'],
                  editedDraft: draft,
                }
              : {
                  ok: true,
                  fixable: false,
                  errors: [],
                  payload: { confidence: 1, outcome: 'valid' },
                },
          );
        },
      },
      'write',
    );

    expect(resumed.ok).toBe(true);
    expect(checks).toBe(2);
    // The verifier makes the correction and checks it again. The original
    // implementer is never restarted, even in a replacement worker.
    expect(await readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8')).toBe(
      '1\n',
    );
  });

  it('should bound verifier-owned edits at five rounds while retaining the last edit for delivery', async () => {
    const ctx = await workdir();
    let rounds = 0;
    const result = await runStage(
      {
        ...ctx,
        command: await fakeCodex(ctx.dir, [draft]),
        validateCopy: (candidate) => {
          expect((candidate as typeof draft).confidence).toBe(
            rounds ? rounds / 10 : draft.confidence,
          );
          rounds += 1;

          return Promise.resolve({
            ok: false,
            fixable: true,
            errors: [`Finding ${rounds}`],
            editedDraft: { ...draft, confidence: rounds / 10 },
          });
        },
      },
      'write',
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toMatchObject({ attempts: 5, refusals: 5 });
    expect(rounds).toBe(5);
    expect(await readFile(path.join(ctx.dir, 'fake-attempts'), 'utf8')).toBe(
      '1\n',
    );
    expect(
      JSON.parse(
        await readFile(path.join(ctx.dir, 'PENDING/write-0.json'), 'utf8'),
      ),
    ).toMatchObject({ rounds: 5, draft: { confidence: 0.5 } });
  });
});

describe('Stage - runStage() in batches', () => {
  const second = {
    ...capturedAnswer,
    surface: 'chatgpt',
    probe: {
      text: 'Render and Vercel both work.\n\nSources used by search:\n- https://render.com',
    },
  } as unknown as CapturedUnitRecord;

  it('should partition answers in canonical order into batches of the given size', () => {
    const answers = [
      {
        file: 'b',
        sectionKey: 's',
        promptId: 'p2',
        surface: 'chatgpt',
        runIndex: 1,
        body: '',
      },
      {
        file: 'a',
        sectionKey: 's',
        promptId: 'p1',
        surface: 'perplexity',
        runIndex: 2,
        body: '',
      },
      {
        file: 'c',
        sectionKey: 's',
        promptId: 'p1',
        surface: 'perplexity',
        runIndex: 1,
        body: '',
      },
    ];

    const batches = partition(answers, 2);

    expect(
      batches.map((batch) => batch.files.map((file) => file.file)),
    ).toEqual([['c', 'a'], ['b']]);
    expect(batches.map((batch) => batch.index)).toEqual([0, 1]);
  });

  it('should run one session per batch, merge the rows, and reuse accepted batches on the next run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeo-codex-'));
    const answers = await materializeWorkdir({
      dir,
      config,
      captured: [capturedAnswer, second],
      copyRules: '# copy',
    });

    await mkdir(path.join(dir, 'JOURNAL'), { recursive: true });

    const ctx: StageContext = {
      dir,
      brand,
      answers,
      stageModel: testStageModelFixture,
      timeoutMs: 20_000,
      batchSize: 1,
      concurrency: 1,
    };

    const rowFor = (file: string) => {
      return { ...goodAnalyzeRow, file };
    };
    // The fake serves outputs by invocation count; with one batch in
    // flight at a time, batch 0 (chatgpt, first in canonical order) gets
    // the first and batch 1 the second.
    const outputs = [
      { rows: [rowFor('ANSWERS/hosting/h1/chatgpt-1.md')] },
      { rows: [rowFor('ANSWERS/hosting/h1/perplexity-1.md')] },
    ];

    const command = await fakeCodex(dir, outputs);
    const run = await runStage({ ...ctx, command }, 'analyze');

    expect(run.errors).toEqual([]);
    expect(run.summary).toEqual({
      batches: 2,
      reused: 0,
      attempts: 2,
      refusals: 0,
      rows: 2,
    });

    const merged = await readJson<AnalyzeOutput>(
      path.join(dir, 'OUT', 'analyze.json'),
    );

    expect(merged.rows.map((row) => row.file)).toEqual([
      'ANSWERS/hosting/h1/chatgpt-1.md',
      'ANSWERS/hosting/h1/perplexity-1.md',
    ]);

    const attempts = Number(
      await readFile(path.join(dir, 'fake-attempts'), 'utf8'),
    );
    const again = await runStage({ ...ctx, command }, 'analyze');

    expect(again.summary).toEqual({
      batches: 2,
      reused: 2,
      attempts: 0,
      refusals: 0,
      rows: 2,
    });
    expect(
      Number(await readFile(path.join(dir, 'fake-attempts'), 'utf8')),
    ).toBe(attempts);
  });

  it('should give one name to an alternative that batches named differently', () => {
    const quote = 'q';
    const rows = canonicalizeQualifiedNames([
      {
        file: 'a',
        qualifiedCompetitors: [{ name: 'Cloud Run', domain: null, quote }],
      },
      {
        file: 'b',
        qualifiedCompetitors: [
          { name: 'Google Cloud Run', domain: 'cloud.google.com', quote },
          { name: 'cloud run', domain: null, quote },
          { name: 'Vercel', domain: 'vercel.com', quote },
        ],
      },
    ]);

    expect(rows[0]?.qualifiedCompetitors).toEqual([
      { name: 'Google Cloud Run', domain: 'cloud.google.com', quote },
    ]);
    expect(rows[1]?.qualifiedCompetitors.map((entry) => entry.name)).toEqual([
      'Google Cloud Run',
      'Vercel',
    ]);
  });

  it('should leave a short form as written when two vendors share it', () => {
    const quote = 'q';
    const rows = canonicalizeQualifiedNames([
      {
        file: 'a',
        qualifiedCompetitors: [{ name: 'Edge Functions', domain: null, quote }],
      },
      {
        file: 'b',
        qualifiedCompetitors: [
          { name: 'Vercel Edge Functions', domain: 'vercel.com', quote },
        ],
      },
      {
        file: 'c',
        qualifiedCompetitors: [
          { name: 'Netlify Edge Functions', domain: 'netlify.com', quote },
        ],
      },
      // A domain settles it: this short form is Netlify's.
      {
        file: 'd',
        qualifiedCompetitors: [
          { name: 'Edge Functions', domain: 'netlify.com', quote },
        ],
      },
    ]);

    expect(rows[0]?.qualifiedCompetitors[0]).toEqual({
      name: 'Edge Functions',
      domain: null,
      quote,
    });
    expect(rows[3]?.qualifiedCompetitors[0]).toEqual({
      name: 'Netlify Edge Functions',
      domain: 'netlify.com',
      quote,
    });
  });

  it('should merge review batches: one unaccepted batch keeps the pass open and a failed criterion fails', () => {
    const pass = { criterionId: 'x', outcome: 'pass' as const };
    const merged = mergeBatches('review', [
      {
        verdict: 'accepted',
        criteria: [pass, { criterionId: 'y', outcome: 'pass' }],
        corrections: [],
        unresolved: [],
      },
      {
        verdict: 'needs_another_pass',
        criteria: [pass, { criterionId: 'y', outcome: 'fail' }],
        corrections: [],
        unresolved: [
          {
            criterionId: 'y',
            stage: 'qualify',
            file: null,
            problem: 'p',
            evidence: 'e',
            whyNotFixed: 'w',
          },
        ],
      },
    ]) as {
      verdict: string;
      criteria: { criterionId: string; outcome: string }[];
      unresolved: unknown[];
    };

    expect(merged.verdict).toBe('needs_another_pass');
    expect(merged.criteria).toEqual([
      { criterionId: 'x', outcome: 'pass' },
      { criterionId: 'y', outcome: 'fail' },
    ]);
    expect(merged.unresolved).toHaveLength(1);
  });
});

describe('Stage - stageInputsDigest()', () => {
  it('should change only for the stage whose inputs changed', async () => {
    const ctx = await workdir();
    const before = {
      analyze: await stageInputsDigest(ctx, 'analyze'),
      qualify: await stageInputsDigest(ctx, 'qualify'),
    };

    // A new qualify output is downstream of analyze: analyze stays fresh.
    await writeFile(
      path.join(ctx.dir, 'OUT', 'qualify.json'),
      '{"rows":[],"corrections":[]}',
    );
    expect(await stageInputsDigest(ctx, 'analyze')).toBe(before.analyze);
    // A rule both read changes both.
    await writeFile(path.join(ctx.dir, 'RULES', 'analysis.md'), '# changed');
    expect(await stageInputsDigest(ctx, 'analyze')).not.toBe(before.analyze);
    expect(await stageInputsDigest(ctx, 'qualify')).not.toBe(before.qualify);
  });
});

describe('Checks - validateStage()', () => {
  const ctx = {
    brand,
    coverage: true,
    answers: [
      {
        file: 'ANSWERS/hosting/h1/perplexity-1.md',
        sectionKey: 'hosting',
        promptId: 'h1',
        surface: 'perplexity',
        runIndex: 1,
        body: 'Vercel is the common pick; Deno Deploy works too.',
      },
    ],
  };

  it('should judge a correction on row consistency, not batch coverage, so a degraded run can still be corrected', () => {
    const degradedCtx = {
      ...ctx,
      answers: [
        ...ctx.answers,
        {
          file: 'ANSWERS/hosting/h1/chatgpt-1.md',
          sectionKey: 'hosting',
          promptId: 'h1',
          surface: 'chatgpt',
          runIndex: 1,
          body: 'x',
        },
      ],
    };

    const output = { rows: [goodAnalyzeRow] };

    expect(validateStage(degradedCtx, 'analyze', output).errors).toEqual([
      'ANSWERS/hosting/h1/chatgpt-1.md: no row',
    ]);
    expect(
      validateStage({ ...degradedCtx, coverage: false }, 'analyze', output)
        .errors,
    ).toEqual([]);
  });

  it('should drop the prospect from the brand list of a row that marks it absent', () => {
    const row = { ...goodAnalyzeRow, prospectMentioned: false };
    const { value, errors } = validateStage(ctx, 'analyze', { rows: [row] });

    expect(errors).toEqual([]);
    expect(
      (value as typeof goodAnalyze).rows[0]?.mentionedBrands.map((b) => b.name),
    ).toEqual(['Vercel']);
  });

  it('should drop the client itself and its owned hosts from the qualified alternatives, exactly those', () => {
    const entry = (name: string, domain: string | null) => {
      return {
        name,
        domain,
        quote: 'Vercel is the common pick',
      };
    };

    const { value, errors } = validateStage(
      { ...ctx, ownedDomains: ['WWW.Deno.Land.'] },
      'qualify',
      {
        rows: [
          {
            file: 'ANSWERS/hosting/h1/perplexity-1.md',
            qualifiedCompetitors: [
              entry('Vercel', 'vercel.com'),
              entry('Deno Deploy', 'deno.com'),
              entry('Deno', null),
              entry('Deno Land', 'deno.land'),
              entry('Deno Docs', 'docs.deno.land'),
              entry('NotDeno', 'notdeno.land'),
            ],
          },
        ],
        corrections: [],
      },
    );

    expect(errors).toEqual([]);
    expect(
      (
        value as { rows: { qualifiedCompetitors: { name: string }[] }[] }
      ).rows[0]?.qualifiedCompetitors.map((row) => row.name),
    ).toEqual(['Vercel', 'Deno Docs', 'NotDeno']);
  });

  it('should keep two products of one vendor apart and refuse the same product twice', () => {
    const rowWith = (names: string[]) => {
      return {
        rows: [
          {
            file: 'ANSWERS/hosting/h1/perplexity-1.md',
            qualifiedCompetitors: names.map((name) => ({
              name,
              domain: 'vercel.com',
              quote: 'Vercel is the common pick',
            })),
          },
        ],
        corrections: [],
      };
    };

    expect(
      validateStage(
        ctx,
        'qualify',
        rowWith(['Vercel Functions', 'Vercel Edge Functions']),
      ).errors,
    ).toEqual([]);
    expect(
      validateStage(
        ctx,
        'qualify',
        rowWith(['Vercel Functions', 'vercel  functions']),
      ).errors,
    ).toEqual([
      'ANSWERS/hosting/h1/perplexity-1.md: vercel  functions qualified twice',
    ]);
  });

  it('should restore source formatting in a qualification quote without another model call', () => {
    const body =
      'Choose **Vercel** when developer experience and quick deployment matter most.';
    const output = {
      rows: [
        {
          file: firstOf(ctx.answers).file,
          qualifiedCompetitors: [
            {
              name: 'Vercel Functions',
              domain: 'vercel.com',
              quote:
                'Choose Vercel when developer experience and quick deployment matter most.',
            },
          ],
        },
      ],
      corrections: [],
    };

    const scope = { ...ctx, answers: [{ ...firstOf(ctx.answers), body }] };
    const checked = validateStage(scope, 'qualify', output);

    expect(checked.errors).toEqual([]);

    const stored = checked.value as typeof output;

    expect(stored.rows[0]?.qualifiedCompetitors[0]?.quote).toBe(body);
    expect(validateStage(scope, 'qualify', stored).errors).toEqual([]);

    const entry = firstOf(firstOf(output.rows).qualifiedCompetitors);

    entry.quote = 'Choose Vercel when the lowest price matters most.';
    expect(validateStage(scope, 'qualify', output).errors[0]).toContain(
      'is not in the answer body',
    );
  });

  it('should refuse a qualification quote that is not in the answer body', () => {
    const { errors } = validateStage(ctx, 'qualify', {
      rows: [
        {
          file: 'ANSWERS/hosting/h1/perplexity-1.md',
          qualifiedCompetitors: [
            {
              name: 'Vercel',
              domain: 'vercel.com',
              quote: 'from the sources block',
            },
          ],
        },
      ],
      corrections: [],
    });

    expect(errors[0]).toMatch(/quote for Vercel is not in the answer body/);
  });

  it('should refuse an accepted review that still lists problems', () => {
    const { errors } = validateStage(ctx, 'review', {
      verdict: 'accepted',
      criteria: [{ criterionId: 'x', outcome: 'pass' }],
      corrections: [],
      unresolved: [
        {
          criterionId: 'x',
          stage: 'analyze',
          file: null,
          problem: 'p',
          evidence: 'e',
          whyNotFixed: 'w',
        },
      ],
    });

    expect(errors).toEqual(['accepted with unresolved problems listed']);
  });
});

describe('Schemas - stageJsonSchema()', () => {
  // The structured-output endpoint refuses a property without a type
  // (`z.unknown()` became `{}` and failed the first live qualify stage).
  const untyped = (schema: unknown, at = '$'): string[] => {
    if (!schema || typeof schema !== 'object') {
      return [];
    }

    const node = schema as Record<string, unknown>;
    const out: string[] = [];

    if (
      !('type' in node) &&
      !('enum' in node) &&
      !('anyOf' in node) &&
      !('$ref' in node) &&
      !('const' in node)
    ) {
      out.push(at);
    }

    for (const [key, value] of Object.entries(
      (node.properties ?? {}) as Record<string, unknown>,
    )) {
      out.push(...untyped(value, `${at}.${key}`));
    }

    if (node.items) {
      out.push(...untyped(node.items, `${at}[]`));
    }

    return out;
  };

  for (const stage of Object.keys(stageSchemas) as StageName[]) {
    it(`${stage}: every property carries a type`, () => {
      expect(untyped(stageJsonSchema(stage))).toEqual([]);
    });
  }
});

describe('Stage - fieldPath()', () => {
  it('should read a top-level field and a nested indexed path', () => {
    expect(fieldPath('prospectMentioned')).toEqual(['prospectMentioned']);
    expect(fieldPath('qualifiedCompetitors[0].quote')).toEqual([
      'qualifiedCompetitors',
      '0',
      'quote',
    ]);
  });
});

describe('Stage - correctionValue()', () => {
  it('should decode JSON text and keep an unquoted word as a string', () => {
    expect(correctionValue('"listed"')).toBe('listed');
    expect(correctionValue('false')).toBe(false);
    expect(
      correctionValue('[{"name":"Vercel","domain":"vercel.com"}]'),
    ).toEqual([{ name: 'Vercel', domain: 'vercel.com' }]);
    expect(correctionValue('listed')).toBe('listed');
  });
});
