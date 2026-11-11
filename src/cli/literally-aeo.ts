import { Console } from 'node:console';
import { toolVersion } from '../bundle/contracts';
import { runExport, runVerify, runView } from './bundle-commands';
import { runGuide } from './guide-command';
import { parseFlags, writeErr, writeOut } from './io';
import {
  runDoctor,
  runInit,
  runAuthor,
  runPlan,
  runRejudge,
  runRun,
} from './run-commands';
import { runStatus } from './status-command';

// ============================================================================
// literally-aeo (specs/aeo-open-source-cli-spec.md §4.3). No command loads
// .env.local, reads a database or sends telemetry; only `run` contacts a
// provider. Results go to stdout, progress and branding to stderr.
// ============================================================================

const usageText = `Literally.dev AEO ${toolVersion}

Usage:
  literally-aeo init [--config audit.json]
  literally-aeo doctor [--config audit.json] [--env-file .env] [--output audit-run]
  literally-aeo plan [--config audit.json] [--output audit-run]
  literally-aeo run [--config audit.json] [--env-file .env] [--output audit-run] [--max-usd N] [--budget-file limits.json]
  literally-aeo author --brief brief.json [--estimate] [--max-usd N] [--model <id>] [--output audit-draft] [--env-file .env]
  literally-aeo rejudge <run-dir> --output <new-run-dir> [--model <id>] [--effort <level>] [--max-usd N] [--config audit.json] [--env-file .env]
  literally-aeo view <archive|bundle-dir|run-dir> [--working] [--port N]
  literally-aeo export <run-dir> [--output <file.aeo.zip>] [--env-file <file>] [--accept-findings] [--redact redactions.json]
  literally-aeo verify <archive|bundle-dir|run-dir>
  literally-aeo status <run-dir>
  literally-aeo guide

Every command takes --json (a versioned result on stdout) and --quiet.

init writes an example audit.json and .env.example, never over a file.
doctor checks the model, the CLIs, settings and run directory a run needs;
settings are named, never shown, and a model the gateway's model list has
no price for is refused. plan prints what a run would measure, its
estimated cost as a range, and whether the run directory is new, resumable
or completed. Both are offline, except that a model the engine ships no
settings for is priced from the gateway's free public model list
(AEO_MODEL_CATALOG names a saved copy). run measures: it captures every planned answer
(reusing what the run directory already holds), judges, reviews and writes
the report; running it again resumes. A new run starts only under an
approved cap, --max-usd or runPolicy.budget.maxUsd, which covers every
paid call (probes, Codex stages, host model calls, searches); without one
it prints the estimate and spends nothing. A run freezes its cap and its
model; --max-usd or --budget-file raises the cap of a run, recorded.
author researches a brief (JSON: companyName, website,
desiredRecommendation, and optionally competitors, moneyPages, notes) and
proposes an audit.json beside the record of the session; --estimate prints
what that costs and spends nothing, and the session needs --max-usd. A run
of that file bundles the record and the diff from proposal to final.
rejudge judges a finished run's captures again in a new run directory,
carrying the original revision as its predecessor; nothing is probed
again, and --model judges with another model, --effort at another
reasoning effort the gateway lists for it. view serves the
report and its evidence on this machine only (127.0.0.1, a one-time link);
a run directory without a finalized revision shows its working state,
labelled as such. export packs a run directory into a portable archive;
verify checks one offline. status reports a run directory's phase,
answers and spend against its cap, read-only, beside a live run too. guide
prints the protocol an AI agent follows to run an audit for a user.

Settings come from the process environment first, then the env file
(default ./.env); no other file is read.

Exit codes: 0 done; 1 invalid input, a failed check or an error; 2 stopped
before or during work and resumable (no approved cap, the cap reached,
missing setting, failed canary, a live writer holding the run), or an
unsupported bundle; 3 done with disclosed limitations; 128 plus the signal
number when interrupted.`;

const main = async (argv: readonly string[]) => {
  const flags = parseFlags(argv);
  const [command, ...rest] = flags.positional;
  const commandFlags = { ...flags, positional: rest };

  if (command === undefined || flags.switches.has('--help')) {
    writeOut(usageText);

    return 0;
  }

  if (!flags.switches.has('--quiet') && !flags.switches.has('--json')) {
    writeErr(`Literally.dev AEO ${toolVersion}`);
  }

  switch (command) {
    case 'init':
      return runInit(commandFlags);

    case 'doctor':
      return runDoctor(commandFlags);

    case 'plan':
      return runPlan(commandFlags);

    case 'run':
      return runRun(commandFlags);

    case 'rejudge':
      return runRejudge(commandFlags, usageText);

    case 'author':
      return runAuthor(commandFlags, usageText);

    case 'export':
      return runExport(commandFlags, usageText);

    case 'verify':
      return runVerify(commandFlags, usageText);

    case 'view':
      return runView(commandFlags, usageText);

    case 'status':
      return runStatus(commandFlags, usageText);

    case 'guide':
      return runGuide(commandFlags);

    default:
      throw new Error(usageText);
  }
};

// Library modules log progress through the console; stdout carries only the
// command's result, so --json output stays machine-readable (spec §4.3).
globalThis.console = new Console({
  stdout: process.stderr,
  stderr: process.stderr,
});

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  writeErr(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
