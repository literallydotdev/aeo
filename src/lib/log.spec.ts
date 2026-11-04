import { describe, expect, it, vi } from 'vitest';
import { createLog } from './log';

const ansiPattern = /\[\d+m/g;

const captureErrorLine = (error: unknown, fields?: Record<string, unknown>) => {
  const mockConsoleError = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);

  createLog('TestComponent').error('Operation failed:', error, fields);

  const [call] = mockConsoleError.mock.calls;
  const line = String(call?.[0]).replace(ansiPattern, '');

  return line;
};

describe('log - createLog().error()', () => {
  it('should print the cause chain, nearest cause first', () => {
    const root = new Error('connection refused');
    const middle = new Error('query failed', { cause: root });
    const error = new Error('save failed', { cause: middle });

    const line = captureErrorLine(error, { runId: 'test-run-1' });

    expect(line).toContain(
      '[TestComponent] Operation failed: error=save failed cause=query failed <- connection refused stack=',
    );
    expect(line).toContain(' runId=test-run-1');
  });

  it('should print a non-Error cause as a string', () => {
    const error = new Error('save failed', { cause: 'socket closed' });

    const line = captureErrorLine(error);

    expect(line).toContain('error=save failed cause=socket closed stack=');
  });

  it('should stop at a cause that points back into the chain', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;

    const line = captureErrorLine(first);

    expect(line).toContain('error=first cause=second stack=');
  });

  it('should NOT print a cause field when the error has no cause', () => {
    const line = captureErrorLine(new Error('save failed'));

    expect(line).not.toContain('cause=');
    expect(line).toContain('error=save failed stack=');
  });
});
