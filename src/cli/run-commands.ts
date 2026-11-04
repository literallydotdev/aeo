import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WriterLockHeldError } from '../bundle/writer-lock';
import { workflowSecrets } from '../codex-workflow/codex-home';
import { prepareWorkdir, runWorkflow } from '../codex-workflow/loop';
import { readAuditFile, type AuditFile } from '../engine/audit-file';
import { readSettings, type Settings } from '../engine/env-file';
import { readBudgetAmendment, type BudgetAmendment } from '../engine/budget';
import {
  openLocalRun,
  planLocalRun,
  PreflightFailedError,
  runDirectoryState,
  usesGroundingSearch,
} from '../engine/local-run';
import {
  credentialSettingNames,
  runPreflight,
  runSettingNames,
} from '../engine/preflight';
import { prepareRejudgment } from '../engine/rejudge';
import {
  readAuthorEvidence,
  readBrief,
  runLocalAuthor,
} from '../engine/author';
import {
  auditCopyFile,
  readRecordedAuthorEvidence,
  recordRunConfiguration,
  type RecordedAuthorEvidence,
} from '../engine/run-configuration';
import { engineResources } from '../engine/resources';
import { exampleAuditFile, exampleEnvFile } from '../engine/templates';
import { getEnvironment, writeEnv } from '../lib/env';
import { ModelBudgetError } from '../models/accounting';
import { hasErrorCode } from '../stores/fs-errors';
import { formatLine, writeErr, writeOut, type Flags } from './io';

// ============================================================================
// init, doctor, plan and run (specs/aeo-open-source-cli-spec.md §4.1, §4.3).
// init, doctor and plan never contact a provider; run is the only command
// that spends money, and it checks what it can before it does.
// ============================================================================

const configPathOf = (flags: Flags) => {
  return path.resolve(flags.options.get('--config') ?? 'audit.json');
};

const runDirOf = (flags: Flags) => {
  return path.resolve(flags.options.get('--output') ?? 'audit-run');
};

/** init writes the two templates beside each other, never over an
 * existing file. */
export const runInit = async (flags: Flags) => {
  const created: string[] = [];
  const kept: string[] = [];
  const configFile = configPathOf(flags);
  const templates = [
    [configFile, `${JSON.stringify(exampleAuditFile, null, 2)}\n`],
    [path.join(path.dirname(configFile), '.env.example'), exampleEnvFile],
  ] as const;

  for (const [file, content] of templates) {
    try {
      await writeFile(file, content, { flag: 'wx' });
      created.push(file);
    } catch (err) {
      if (!hasErrorCode(err, 'EEXIST')) {
        throw err;
      }

      kept.push(file);
    }
  }

  writeOut(
    [
      ...created.map((file) => `Created: ${file}`),
      ...kept.map((file) => `Kept (already exists): ${file}`),
      '',
      'Next: replace the example company, competitors and questions in audit.json,',
      'copy .env.example to .env and fill in the keys, then run `literally-aeo doctor`.',
      'Keep .env and the run directory (audit-run/) out of source control.',
    ].join('\n'),
  );

  return 0;
};

export const runDoctor = async (flags: Flags) => {
  const file = await readAuditFile(configPathOf(flags));
  const { plan, request } = planLocalRun(file);
  const settings = await readSettings(flags.options.get('--env-file'));
  const checks = await runPreflight({
    surfaces: plan.surfaces,
    settings,
    dir: runDirOf(flags),
    groundingSearch: usesGroundingSearch(request),
  });
  const ok = checks.every((check) => check.ok);

  if (flags.switches.has('--json')) {
    writeOut(
      JSON.stringify({ resultVersion: 1, command: 'doctor', ok, checks }),
    );
  } else {
    writeOut(
      [
        `Env file: ${settings.file}${settings.fileFound ? '' : ' (not found)'}`,
        ...checks.map((check) =>
          formatLine(
            check.name,
            `${check.ok ? 'ok' : 'MISSING'}  ${check.detail}`,
          ),
        ),
      ].join('\n'),
    );
  }

  return ok ? 0 : 1;
};

export const runPlan = async (flags: Flags) => {
  const file = await readAuditFile(configPathOf(flags));
  const { config, request, plan, digests } = planLocalRun(file);
  const dir = runDirOf(flags);
  const state = await runDirectoryState(dir);
  const bySurface = Object.fromEntries(plan.probesBySurface);
  const summary = {
    brand: config.brand.name,
    sections: config.sections.map((section) => ({
      key: section.key,
      questions: section.prompts.length,
    })),
    surfaces: plan.surfaces,
    plannedAnswers: plan.units.length,
    plannedAnswersBySurface: bySurface,
    maxPlannedUnits: request.maxPlannedUnits,
    grounding: request.grounding,
    budget: file.runPolicy.budget,
    // What the budget can actually stop (spec §6): the host's model calls.
    budgetEnforcedFor: [
      'host model calls (perception, labels, grounding, copy verifier)',
    ],
    budgetRecordedOnly: ['probe answers', 'Codex stage sessions'],
    runDirectory: { path: dir, state },
    digests,
  };

  if (flags.switches.has('--json')) {
    writeOut(JSON.stringify({ resultVersion: 1, command: 'plan', ...summary }));

    return 0;
  }

  writeOut(
    [
      formatLine('Brand', summary.brand),
      ...summary.sections.map((section) =>
        formatLine(`Section ${section.key}`, `${section.questions} questions`),
      ),
      formatLine('Surfaces', summary.surfaces.join(', ')),
      ...Object.entries(bySurface).map(([surface, count]) =>
        formatLine(`  ${surface}`, `${count} answers`),
      ),
      formatLine(
        'Planned answers',
        `${summary.plannedAnswers} (cap ${summary.maxPlannedUnits})`,
      ),
      formatLine(
        'Grounding',
        summary.grounding === 'full'
          ? 'full (claims researched and adjudicated)'
          : 'extraction_only (claims inventoried, not researched)',
      ),
      formatLine(
        'Budget',
        `${'$'}${summary.budget.maxUsd}, ${summary.budget.maxTokens} tokens, ${summary.budget.maxHours} h`,
      ),
      formatLine('  enforced for', summary.budgetEnforcedFor.join('; ')),
      formatLine(
        '  recorded, not capped',
        summary.budgetRecordedOnly.join('; '),
      ),
      formatLine('Run directory', `${dir} (${state})`),
      formatLine('Measurement digest', digests.measurement),
      formatLine('Plan digest', digests.plan),
    ].join('\n'),
  );

  return 0;
};

/** run executes the workflow over the run directory; running it again
 * resumes. Exit codes follow spec §4.3. */
export const runRun = async (flags: Flags) => {
  const file = await readAuditFile(configPathOf(flags));
  const dir = runDirOf(flags);
  const settings = await readSettings(flags.options.get('--env-file'));
  const { plan, request } = planLocalRun(file);
  const budgetFile = flags.options.get('--budget-file');
  const amendment = budgetFile
    ? await readBudgetAmendment(path.resolve(budgetFile))
    : undefined;
  const checks = await runPreflight({
    surfaces: plan.surfaces,
    settings,
    dir,
    groundingSearch: usesGroundingSearch(request),
  });
  const failing = checks.filter((check) => !check.ok);

  if (failing.length > 0) {
    writeErr(
      [
        'Not started: fix these first (literally-aeo doctor lists them all).',
        ...failing.map((check) => `  ${check.name}: ${check.detail}`),
      ].join('\n'),
    );

    return 2;
  }

  return executeRun({
    file,
    configFile: configPathOf(flags),
    dir,
    settings,
    amendment,
  });
};

/** author researches a brief and proposes an audit.json (spec §4.1). */
export const runAuthor = async (flags: Flags, usage: string) => {
  const briefFile = flags.options.get('--brief');

  if (briefFile === undefined) {
    throw new Error(usage);
  }

  const brief = await readBrief(path.resolve(briefFile));
  const dir = path.resolve(flags.options.get('--output') ?? 'audit-draft');
  const settings = await readSettings(flags.options.get('--env-file'));
  // The author researches through the pinned search provider, so its key
  // is a requirement, never a silent `unavailable`.
  const checks = await runPreflight({
    surfaces: [],
    settings,
    dir,
    groundingSearch: true,
  });
  const failing = checks.filter((check) => !check.ok);

  if (failing.length > 0) {
    writeErr(
      [
        'Not started: fix these first.',
        ...failing.map((check) => `  ${check.name}: ${check.detail}`),
      ].join('\n'),
    );

    return 2;
  }

  settings.apply(runSettingNames);

  const resources = await engineResources();

  writeEnv('AEO_AUTHOR_DIR', resources.author);
  writeEnv('AEO_EDITORIAL_DIR', resources.editorial);

  try {
    const result = await runLocalAuthor({
      brief,
      dir,
      secrets: settings.values(credentialSettingNames),
    });

    writeOut(
      [
        formatLine('Draft directory', dir),
        formatLine('Proposed audit.json', result.auditFile ?? 'not produced'),
        formatLine(
          'Research',
          `${result.research.pagesRead} pages read, ${result.research.searches} searches`,
        ),
        ...result.errors.slice(0, 5).map((error) => `  ${error.slice(0, 300)}`),
        '',
        result.ok
          ? 'Review and edit audit.json, keep author-record.json beside it, then run literally-aeo run --config <that file>.'
          : 'No configuration was proposed; the reasons are above.',
      ].join('\n'),
    );

    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof WriterLockHeldError) {
      writeErr(err.message);

      return 2;
    }

    throw err;
  }
};

/** rejudge judges a finished run's captures again in a new directory;
 * running it again over that directory resumes it. */
export const runRejudge = async (flags: Flags, usage: string) => {
  const source = flags.positional[0];
  const output = flags.options.get('--output');

  if (source === undefined || output === undefined) {
    throw new Error(usage);
  }

  const sourceDir = path.resolve(source);
  const dir = path.resolve(output);

  if (sourceDir === dir) {
    throw new Error(
      'Please give the rejudgment its own --output: a rejudgment never changes the run it derives from.',
    );
  }

  if ((await runDirectoryState(sourceDir)) === 'new') {
    writeErr(
      `${sourceDir} holds no run to rejudge. Measure first: literally-aeo run --output ${sourceDir}`,
    );

    return 1;
  }

  // By default a rejudgment judges against the configuration the source
  // ran from, and keeps that configuration's author evidence.
  const configOption = flags.options.get('--config');
  const configFile =
    configOption === undefined
      ? path.join(sourceDir, auditCopyFile)
      : path.resolve(configOption);
  const evidence =
    configOption === undefined
      ? await readRecordedAuthorEvidence(sourceDir)
      : undefined;
  const file = await readAuditFile(configFile);
  const settings = await readSettings(flags.options.get('--env-file'));
  const { plan, request } = planLocalRun(file);
  const lineage = await prepareRejudgment({
    source: sourceDir,
    target: dir,
    file,
    secrets: settings.values(credentialSettingNames),
    acceptFindings: flags.switches.has('--accept-findings'),
  });
  const checks = await runPreflight({
    surfaces: plan.surfaces,
    settings,
    dir,
    groundingSearch: usesGroundingSearch(request),
  });
  const failing = checks.filter((check) => !check.ok);

  if (failing.length > 0) {
    writeErr(
      [
        'Not started: fix these first (literally-aeo doctor lists them all).',
        ...failing.map((check) => `  ${check.name}: ${check.detail}`),
      ].join('\n'),
    );

    return 2;
  }

  writeErr(
    `Rejudging run ${lineage.runId} (revision ${lineage.revisionId}) into ${dir}: the captures are reused, nothing is probed again.`,
  );

  return executeRun({
    file,
    configFile,
    dir,
    settings,
    evidence,
    derivedFromRunId: lineage.runId,
  });
};

type ExecuteRunOptions = {
  file: AuditFile;
  /** Where audit.json is: its author record is resolved beside it. */
  configFile: string;
  dir: string;
  settings: Settings;
  amendment?: BudgetAmendment;
  /** Author evidence already recorded; read beside configFile otherwise. */
  evidence?: RecordedAuthorEvidence;
  /** The run a rejudgment derives from. */
  derivedFromRunId?: string;
};

/** executeRun runs the workflow over a prepared run directory, after its
 * preflight has passed. Exit codes follow spec §4.3. */
const executeRun = async ({
  file,
  configFile,
  dir,
  settings,
  amendment,
  evidence,
  derivedFromRunId,
}: ExecuteRunOptions) => {
  // The engine's probe and model modules read the process environment.
  settings.apply(runSettingNames);
  await recordRunConfiguration({
    dir,
    configFile,
    evidence: evidence ?? (await readAuthorEvidence(configFile, file)),
  });

  // The copy stage reads its rules and publisher context from the engine,
  // whatever an inherited environment points them at.
  const resources = await engineResources();

  writeEnv('AEO_AUTHOR_DIR', resources.author);
  writeEnv('AEO_EDITORIAL_DIR', resources.editorial);

  const controller = new AbortController();
  const signalNumbers = { SIGINT: 2, SIGTERM: 15 } as const;
  let received: keyof typeof signalNumbers = 'SIGINT';
  const stop = (signal: keyof typeof signalNumbers) => {
    received = signal;
    controller.abort();
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const local = await openLocalRun(file, dir, {
      signal: controller.signal,
      amendment,
      derivedFromRunId,
    });

    if (local.budget.policyDiffers) {
      writeErr(
        'audit.json asks for another budget than this run froze; it does not amend a run in progress. Use --budget-file to raise a limit.',
      );
    }

    const ctx = await prepareWorkdir(local.source, dir, {
      secrets: workflowSecrets(getEnvironment()),
      internalModels: local.internalModels,
      signal: controller.signal,
      origin: 'local',
      held: local.held,
    }).catch(async (err: unknown) => {
      await local.held.writer.release();
      await local.source.close();

      throw err;
    });
    let result: Awaited<ReturnType<typeof runWorkflow>>;

    try {
      if (local.budget.amended) {
        await ctx.recorder?.record('budget_amended', local.budget.amended);
      }

      result = await runWorkflow(ctx, { write: false, ground: local.ground });
    } finally {
      await ctx.releaseWriter();
      await local.source.close();
    }

    const needsImprovement =
      result.finish?.snapshot.meta.quality?.needsImprovement === true;
    const limited =
      !result.finish ||
      needsImprovement ||
      result.degraded.length > 0 ||
      result.copyOutcome === 'errored';

    writeOut(
      [
        formatLine('Run directory', dir),
        formatLine(
          'Report snapshot',
          result.finish?.snapshotFile ?? 'not produced',
        ),
        formatLine('Review verdict', result.verdict),
        formatLine('Copy', result.copyOutcome),
        formatLine('Unjudged answers', String(result.degraded.length)),
        formatLine('Needs improvement', needsImprovement ? 'yes' : 'no'),
        '',
        `Export it with: literally-aeo export ${dir}`,
      ].join('\n'),
    );

    return limited ? 3 : 0;
  } catch (err) {
    if (controller.signal.aborted) {
      writeErr(
        'Interrupted: the run is recorded; run the same command to resume.',
      );

      return 128 + signalNumbers[received];
    }

    if (
      err instanceof PreflightFailedError ||
      err instanceof WriterLockHeldError
    ) {
      writeErr(err.message);

      return 2;
    }

    // Spending stops at the limit; the ledger survives for the resume.
    if (err instanceof ModelBudgetError) {
      writeErr(
        `Stopped at the run's budget: ${err.message}. Raise it with --budget-file <limits.json> and run the same command to resume.`,
      );

      return 2;
    }

    throw err;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
};
