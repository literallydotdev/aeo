import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WriterLockHeldError } from '../bundle/writer-lock';
import { workflowSecrets } from '../codex-workflow/codex-home';
import { prepareWorkdir, runWorkflow } from '../codex-workflow/loop';
import { readAuditFile, type AuditFile } from '../engine/audit-file';
import { readSettings, type Settings } from '../engine/env-file';
import {
  BudgetCapMissingError,
  readBudgetAmendment,
  readFrozenBudget,
  RunModelChangedError,
  type BudgetAmendment,
} from '../engine/budget';
import { RunMethodChangedError } from '../engine/run-method';
import {
  describeCostRange,
  estimateAuthorCost,
  estimateRunCost,
  type AuthorCostEstimate,
  type RunCostEstimate,
} from '../engine/cost-estimate';
import {
  bankDir,
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
  defaultProbeBindings,
  profileOf,
  RunBindingsError,
} from '../probes/bindings';
import { estimateBindingsOf } from '../engine/run-bindings';
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
import {
  findSupportedModel,
  recommendedModelId,
  resolveSupportedModel,
} from '../models/supported-models';
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

/** The amount the operator approved with --max-usd, if any. */
const maxUsdOf = (flags: Flags): number | undefined => {
  const value = flags.options.get('--max-usd');

  if (value === undefined) {
    return undefined;
  }

  const usd = Number(value.replace(/^\$/, ''));

  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(
      `Please give --max-usd a positive amount in dollars, such as 40; got ${value}.`,
    );
  }

  return usd;
};

/** The cost lines a person reads, for plan and for a refused run. */
const estimateLines = (estimate: RunCostEstimate | AuthorCostEstimate) => {
  const categories: [string, { low: number; high: number } | undefined][] = [
    [
      'probes',
      'probes' in estimate.categories ? estimate.categories.probes : undefined,
    ],
    ['Codex stages', estimate.categories.stages],
    [
      'host model calls',
      'hostCalls' in estimate.categories
        ? estimate.categories.hostCalls
        : undefined,
    ],
    ['search', estimate.categories.search],
  ];

  return [
    formatLine(
      'Estimated cost',
      `${describeCostRange(estimate)} (an estimate, not a quote; ${estimate.model})`,
    ),
    ...categories.flatMap(([label, range]) =>
      range ? [formatLine(`  ${label}`, describeCostRange(range))] : [],
    ),
    formatLine(
      'Recommended cap',
      `$${estimate.recommendedCapUsd} (the high end)`,
    ),
  ];
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
  // An unsupported model is doctor's finding, not its crash: the rest of
  // the checks still run, against the plan the recommended model would make.
  const isSupported =
    findSupportedModel(file.model ?? recommendedModelId) !== undefined;
  const { plan, request } = planLocalRun(
    isSupported ? file : { ...file, model: undefined },
  );
  const settings = await readSettings(flags.options.get('--env-file'));
  const checks = await runPreflight({
    surfaces: plan.surfaces,
    settings,
    dir: runDirOf(flags),
    model: file.model,
    groundingSearch: usesGroundingSearch(request),
    rendersPages: file.moneyPages.length > 0,
    bindings: await estimateBindingsOf(path.join(runDirOf(flags), bankDir)),
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
  const model = resolveSupportedModel(file.model);
  const bindings = await estimateBindingsOf(path.join(dir, bankDir));
  const estimate = estimateRunCost({
    plan,
    model,
    grounding: request.grounding,
    bindings,
  });
  // A coding agent bills its own plan, or, on an API key, that provider
  // account per use: either way outside the cap, which the plan says.
  const agentBilling = plan.agentSurfaces.flatMap((surface) => {
    const accounts = profileOf(bindings[surface]).settings.flatMap((setting) =>
      setting.billsAccount === undefined
        ? []
        : [`on ${setting.name}, that ${setting.billsAccount} account`],
    );

    return accounts.length === 0
      ? []
      : [
          formatLine(
            `${surface} billing`,
            `on its own login, your plan; ${accounts.join('; ')}, outside this run's cap`,
          ),
        ];
  });
  const summary = {
    brand: config.brand.name,
    model: model.id,
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
    // The cap covers every paid call: probes, Codex stage sessions, host
    // model calls and searches.
    estimate,
    recommendedCapUsd: estimate.recommendedCapUsd,
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
      formatLine('Model', summary.model),
      ...summary.sections.map((section) =>
        formatLine(`Section ${section.key}`, `${section.questions} questions`),
      ),
      formatLine('Surfaces', summary.surfaces.join(', ')),
      ...agentBilling,
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
      ...estimateLines(estimate),
      formatLine(
        'Cap',
        summary.budget.maxUsd === undefined
          ? 'none in audit.json; approve one with run --max-usd <amount>'
          : `${'$'}${summary.budget.maxUsd} (audit.json), covering every paid call`,
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
  const maxUsd = maxUsdOf(flags);
  const refused = await refuseWithoutCap({
    file,
    dir,
    maxUsd,
    estimate: estimateRunCost({
      plan,
      model: resolveSupportedModel(file.model),
      grounding: request.grounding,
      bindings: await estimateBindingsOf(path.join(dir, bankDir)),
    }),
  });

  if (refused !== undefined) {
    return refused;
  }

  const checks = await runPreflight({
    surfaces: plan.surfaces,
    settings,
    dir,
    model: file.model,
    groundingSearch: usesGroundingSearch(request),
    rendersPages: file.moneyPages.length > 0,
    bindings: await estimateBindingsOf(path.join(dir, bankDir)),
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
    maxUsd,
    amendment,
  });
};

/** A run starts only under an amount the operator approved: a new run
 * directory without --max-usd or runPolicy.budget.maxUsd is refused with
 * the estimate, before any paid work (exit 2, nothing spent). A resume
 * keeps the cap it froze. */
const refuseWithoutCap = async ({
  file,
  dir,
  maxUsd,
  estimate,
}: {
  file: AuditFile;
  dir: string;
  maxUsd: number | undefined;
  estimate: RunCostEstimate;
}): Promise<number | undefined> => {
  if (maxUsd !== undefined || file.runPolicy.budget.maxUsd !== undefined) {
    return undefined;
  }

  if (await readFrozenBudget(dir)) {
    return undefined;
  }

  writeErr(
    [
      'Not started: a run needs an approved spending cap. Nothing was spent.',
      ...estimateLines(estimate),
      '',
      `Approve an amount and run again with it, for example: --max-usd ${estimate.recommendedCapUsd}`,
    ].join('\n'),
  );

  return 2;
};

/** author researches a brief and proposes an audit.json (spec §4.1). */
export const runAuthor = async (flags: Flags, usage: string) => {
  const briefFile = flags.options.get('--brief');

  if (briefFile === undefined) {
    throw new Error(usage);
  }

  const brief = await readBrief(path.resolve(briefFile));
  const model = resolveSupportedModel(flags.options.get('--model'));
  const estimate = estimateAuthorCost(model);
  const maxUsd = maxUsdOf(flags);

  // --estimate is free: it reads the brief and prints what researching it
  // would cost, and spends nothing.
  if (flags.switches.has('--estimate') || maxUsd === undefined) {
    if (flags.switches.has('--json')) {
      writeOut(
        JSON.stringify({
          resultVersion: 1,
          command: 'author',
          started: false,
          estimate,
          recommendedCapUsd: estimate.recommendedCapUsd,
        }),
      );
    } else {
      writeOut(
        [
          ...estimateLines(estimate),
          '',
          `Nothing was spent. To research the brief, approve an amount: --max-usd ${estimate.recommendedCapUsd}`,
        ].join('\n'),
      );
    }

    return flags.switches.has('--estimate') ? 0 : 2;
  }

  const dir = path.resolve(flags.options.get('--output') ?? 'audit-draft');
  const settings = await readSettings(flags.options.get('--env-file'));
  // The author researches through the pinned search provider, so its key
  // is a requirement, never a silent `unavailable`.
  const checks = await runPreflight({
    surfaces: [],
    settings,
    dir,
    groundingSearch: true,
    bindings: defaultProbeBindings,
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
      model,
      maxUsd,
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

    if (err instanceof ModelBudgetError) {
      writeErr(
        `Stopped at the approved cap of $${maxUsd}: ${err.message}. Nothing more was spent; run the same command with a higher --max-usd to continue.`,
      );

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
  // --model judges the same captures with another model: the method
  // changes, the measurement does not, and the lineage records both.
  const modelOption = flags.options.get('--model');
  const configured = await readAuditFile(configFile);
  const file =
    modelOption === undefined
      ? configured
      : { ...configured, model: resolveSupportedModel(modelOption).id };
  const settings = await readSettings(flags.options.get('--env-file'));
  const { plan, request } = planLocalRun(file);
  const maxUsd = maxUsdOf(flags);
  const refused = await refuseWithoutCap({
    file,
    dir,
    maxUsd,
    // Nothing is probed again: only the judging and writing are paid.
    estimate: estimateRunCost({
      plan: { units: plan.units, probesBySurface: new Map() },
      model: resolveSupportedModel(file.model),
      grounding: request.grounding,
      bindings: defaultProbeBindings,
    }),
  });

  if (refused !== undefined) {
    return refused;
  }

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
    model: file.model,
    groundingSearch: usesGroundingSearch(request),
    // Nothing is probed again; the settings checked are the same.
    bindings: defaultProbeBindings,
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
    maxUsd,
    ...(modelOption !== undefined && { modelOverride: file.model }),
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
  /** The cap approved on the command line. */
  maxUsd?: number;
  /** The model a rejudgment names outside the configuration file. */
  modelOverride?: string;
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
  maxUsd,
  modelOverride,
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
    ...(modelOverride !== undefined && { model: modelOverride }),
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
      ...(maxUsd !== undefined && { maxUsd }),
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
      ledger: local.ledger,
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
      err instanceof WriterLockHeldError ||
      err instanceof BudgetCapMissingError ||
      err instanceof RunBindingsError
    ) {
      writeErr(err.message);

      return 2;
    }

    if (
      err instanceof RunModelChangedError ||
      err instanceof RunMethodChangedError
    ) {
      writeErr(err.message);

      return 1;
    }

    // Spending stops at the cap; the ledger and every banked answer survive
    // for the resume, which never pays for them again.
    if (err instanceof ModelBudgetError) {
      writeErr(
        `Stopped at the run's cap: ${err.message}. Nothing past the cap was dispatched. To continue, approve a higher amount and run the same command with --max-usd <amount> (or --budget-file <limits.json>); literally-aeo status ${dir} shows the spend so far.`,
      );

      return 2;
    }

    throw err;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
};
