import { describe, expect, it } from 'vitest';
import { WorkerInvocationError } from '../container/protocol';
import {
  classifyAgentError,
  cliFailureSignals,
  describeCliFailure,
} from './agent-clis';
import { AgentStreamError, RejectedWebToolError } from './agent-cli-parsers';
import { ChildProcessError, type ChildRunResult } from './child-process';
import { isCapacityError } from './failure';

// Failure reporting and retry classification for the agent CLI runner. The
// shapes are anchored to real failures: Claude Code's 529 on a 2026-09-03
// re-run (an error message in stream-json stdout, empty stderr)
// and Cursor's resource_exhausted (on stderr).

const childResult = (fields: Partial<ChildRunResult>): ChildRunResult => {
  return {
    stdout: '',
    stderr: '',
    code: 1,
    signal: null,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    ...fields,
  };
};

const childError = (fields: Partial<ChildRunResult>): ChildProcessError => {
  const result = childResult(fields);

  return new ChildProcessError(
    result.timedOut
      ? 'claude exceeded its deadline and was killed'
      : `claude exited with code ${result.code}`,
    result,
  );
};

const claude529Stdout = [
  '{"type":"system","subtype":"init","cwd":"/tmp/scratch"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment."}]},"error":"server_error"}',
].join('\n');

// `codex exec --json` 0.150.1 refusing a request (2026-10-12): the API body
// arrives as JSON text inside Codex's own `error` and `turn.failed` events,
// while stderr carries only the stdin notice.
const codexApiErrorBody = (status: number, message: string): string => {
  return JSON.stringify({
    type: 'error',
    status,
    error: { type: 'invalid_request_error', message },
  });
};

const codexFailedStdout = (status: number, message: string): string => {
  const body = codexApiErrorBody(status, message);

  return [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"turn.started"}',
    JSON.stringify({ type: 'error', message: body }),
    JSON.stringify({ type: 'turn.failed', error: { message: body } }),
  ].join('\n');
};

const codexStdinNotice = 'Reading additional input from stdin...\n';

describe('agent-clis - describeCliFailure()', () => {
  it('should prefer stderr over plain stdout when the CLI wrote anything there', () => {
    expect(
      describeCliFailure(
        childResult({
          code: 1,
          stderr: 'RetriableError: [resource_exhausted] Error\n',
        }),
      ),
    ).toBe('exit 1, stderr: RetriableError: [resource_exhausted] Error');
  });

  it("should surface Claude Code's API error from stream-json stdout when stderr is empty", () => {
    expect(
      describeCliFailure(childResult({ code: 1, stdout: claude529Stdout })),
    ).toBe(
      'exit 1, error event: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
    );
  });

  it("should surface Codex's API error from its error events over the stdin notice on stderr", () => {
    expect(
      describeCliFailure(
        childResult({
          code: 1,
          stdout: codexFailedStdout(
            400,
            "The 'gpt-0' model is not supported when using Codex with a ChatGPT account.",
          ),
          stderr: codexStdinNotice,
        }),
      ),
    ).toBe(
      "exit 1, error event: HTTP 400: The 'gpt-0' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it('should read the Codex agent_message shape and skip events without text', () => {
    const stdout = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"Rate limit reached for this account."}}',
      '{"type":"turn.completed"}',
    ].join('\n');

    expect(describeCliFailure(childResult({ code: 2, stdout }))).toBe(
      'exit 2, last stdout message: Rate limit reached for this account.',
    );
  });

  it('should fall back to the raw tail for non-JSON output and to the exit state alone', () => {
    expect(
      describeCliFailure(childResult({ code: 137, stdout: 'Killed\n' })),
    ).toBe('exit 137, last stdout message: Killed');

    expect(describeCliFailure(childResult({ code: 3 }))).toBe('exit 3');
    expect(
      describeCliFailure(childResult({ code: null, signal: 'SIGKILL' })),
    ).toBe('killed by SIGKILL');
  });
});

describe('agent-clis - cliFailureSignals()', () => {
  it('should expose stderr and error-event messages to the classifier, never plain answer text', () => {
    const answerMentioningRateLimits = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Some APIs apply rate limiting; a 429 means too many requests."}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Some APIs apply rate limiting."}',
    ].join('\n');

    expect(
      cliFailureSignals(
        childResult({ code: 1, stdout: answerMentioningRateLimits }),
      ).errorTexts,
    ).toEqual([]);

    expect(
      cliFailureSignals(childResult({ code: 1, stdout: claude529Stdout }))
        .errorTexts,
    ).toEqual([
      'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      'server_error',
    ]);
  });
});

describe('agent-clis - classifyAgentError()', () => {
  it('should map a 529 in a structured error event to capacity, and an answer about rate limits to cli_error', () => {
    expect(
      classifyAgentError(childError({ code: 1, stdout: claude529Stdout })).kind,
    ).toBe('capacity');

    const chatty = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"HTTP 429 Too Many Requests means rate limiting."}]}}',
    ].join('\n');

    expect(
      classifyAgentError(childError({ code: 1, stdout: chatty })).kind,
    ).toBe('cli_error');
  });

  it("should classify Codex's structured API errors by their HTTP status", () => {
    expect(
      classifyAgentError(
        childError({
          code: 1,
          stdout: codexFailedStdout(429, 'You have hit your usage limit.'),
          stderr: codexStdinNotice,
        }),
      ).kind,
    ).toBe('capacity');

    expect(
      classifyAgentError(
        childError({
          code: 1,
          stdout: codexFailedStdout(401, 'Your session has expired.'),
          stderr: codexStdinNotice,
        }),
      ).kind,
    ).toBe('auth');
  });

  it("should carry the isolated worker's detail as the failure message", () => {
    const failure = classifyAgentError(
      new WorkerInvocationError(
        'cli_error',
        'codex exited with code 1 — exit 1, error event: HTTP 400: model not supported',
      ),
    );

    expect(failure).toEqual({
      kind: 'cli_error',
      message:
        'codex exited with code 1 — exit 1, error event: HTTP 400: model not supported',
    });
    expect(
      classifyAgentError(new WorkerInvocationError('cli_error')).message,
    ).toBe('cli_error');
  });

  it('should read Cursor resource_exhausted from stderr as capacity and login errors as auth', () => {
    expect(
      classifyAgentError(
        childError({
          code: 1,
          stderr: 'RetriableError: [resource_exhausted] Error\n',
        }),
      ).kind,
    ).toBe('capacity');

    expect(
      classifyAgentError(
        childError({ code: 1, stderr: 'Not logged in. Please run /login\n' }),
      ).kind,
    ).toBe('auth');
  });

  it('should map a timeout, a rejected web tool, and stream errors to their kinds', () => {
    expect(
      classifyAgentError(
        childError({ code: null, signal: 'SIGKILL', timedOut: true }),
      ).kind,
    ).toBe('timeout');

    expect(
      classifyAgentError(new RejectedWebToolError('cursor', 'search', 'x'))
        .kind,
    ).toBe('rejected_web_tool');

    expect(
      classifyAgentError(new AgentStreamError('parser', 'torn line')).kind,
    ).toBe('parser');

    expect(
      classifyAgentError(
        new AgentStreamError(
          'cli_error',
          'Claude Code returned an error result',
        ),
      ).kind,
    ).toBe('cli_error');
  });

  it('should never put argv or the prompt into the message', () => {
    const failure = classifyAgentError(childError({ code: 1, stderr: 'boom' }));
    expect(failure.message).toBe(
      'claude exited with code 1 — exit 1, stderr: boom',
    );
  });
});

describe('failure - isCapacityError()', () => {
  it('should recognize provider overload and rate limits', () => {
    for (const message of [
      'Command failed — exit 1, last stdout message: API Error: 529 Overloaded.',
      'RetriableError: [resource_exhausted] Error',
      'HTTP 429 Too Many Requests',
      'rate limit exceeded, retry later',
    ]) {
      expect(isCapacityError(message), message).toBe(true);
    }
  });

  it('should NOT classify ordinary failures as capacity', () => {
    for (const message of [
      'Claude Code stream ended without a result event',
      'Codex returned no agent message — exit 1, stderr: unknown flag --ephemeral',
      'Cursor result event carries no answer text',
    ]) {
      expect(isCapacityError(message), message).toBe(false);
    }
  });
});
