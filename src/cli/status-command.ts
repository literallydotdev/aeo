import path from 'node:path';
import { readRunStatus, type RunStatus } from '../engine/run-status';
import { formatLine, writeErr, writeOut, type Flags } from './io';

// ============================================================================
// literally-aeo status <run-dir> (specs/aeo-claude-operator-spec.md §4.5):
// where a run is, what it has captured and what it has spent against its
// cap. Read-only and offline; safe to poll beside a running writer.
// ============================================================================

const usd = (value: number | undefined) => {
  return value === undefined ? 'unknown' : `$${value.toFixed(2)}`;
};

const toJson = (status: RunStatus) => {
  // JSON carries null where a value is unknown, never a guess.
  const result = {
    resultVersion: 1,
    command: 'status',
    runDirectory: { path: status.dir, state: status.state },
    writer: status.writer ?? null,
    phase: status.phase ?? null,
    lastActivity: status.lastActivity
      ? {
          ...status.lastActivity,
          stage: status.lastActivity.stage ?? null,
          role: status.lastActivity.role ?? null,
        }
      : null,
    completedStages: status.completedStages,
    answers: { ...status.answers, planned: status.answers.planned ?? null },
    spend: {
      ...status.spend,
      capUsd: status.spend.capUsd ?? null,
      deadlineAt: status.spend.deadlineAt ?? null,
      remainingUsd: status.spend.remainingUsd ?? null,
    },
    lastError: status.lastError ?? null,
    stoppedAtBudget: status.stoppedAtBudget,
  };

  return result;
};

const toText = (status: RunStatus) => {
  const { answers, spend, writer, lastError } = status;
  const lines = [
    formatLine('Run directory', `${status.dir} (${status.state})`),
    formatLine(
      'Writer',
      writer
        ? `${writer.purpose}, process ${writer.pid} on ${writer.host} since ${writer.since} (${writer.state})`
        : 'none',
    ),
    formatLine('Phase', status.phase ?? 'not started'),
    formatLine(
      'Stage outputs',
      status.completedStages.length > 0
        ? status.completedStages.join(', ')
        : 'none yet',
    ),
    formatLine(
      'Answers',
      `${answers.captured} captured of ${answers.planned ?? 'unknown'} planned${answers.failed > 0 ? `, ${answers.failed} failed` : ''}`,
    ),
    formatLine(
      'Spend',
      `${usd(spend.chargedUsd)} of ${usd(spend.capUsd)} (${usd(spend.openUsd)} reserved, not settled)`,
    ),
    ...Object.entries(spend.byCategory).map(([category, spent]) =>
      formatLine(`  ${category}`, `${usd(spent.usd)} in ${spent.calls} calls`),
    ),
    formatLine(
      'Last error',
      lastError
        ? `${lastError.type} at ${lastError.at}: ${lastError.reason}`
        : 'none',
    ),
    ...(status.stoppedAtBudget
      ? [
          '',
          "Stopped at the run's cap. To continue, approve a higher amount and run the same command with --max-usd <new total> (or --budget-file <limits.json>); it resumes.",
        ]
      : []),
  ];

  return lines.join('\n');
};

export const runStatus = async (flags: Flags, usage: string) => {
  const target = flags.positional[0];

  if (target === undefined) {
    throw new Error(usage);
  }

  const dir = path.resolve(target);
  const status = await readRunStatus(dir);

  if (!status) {
    writeErr(`${dir} holds no run.`);

    return 1;
  }

  writeOut(
    flags.switches.has('--json')
      ? JSON.stringify(toJson(status))
      : toText(status),
  );

  return 0;
};
