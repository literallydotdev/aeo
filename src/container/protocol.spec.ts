import { describe, expect, it } from 'vitest';
import { workerInputSchema } from './protocol';

describe('protocol - workerInputSchema', () => {
  it('should reject arbitrary commands, environment, paths and unbounded inputs', () => {
    for (const value of [
      { task: 'shell', command: 'env' },
      { task: 'version', env: { AEO_DATABASE_URL: 'secret' } },
      {
        task: 'author',
        prompt: 'write',
        files: { '../auth.json': 'bad' },
        timeoutMs: 1000,
        maxTurns: 10,
      },
      { task: 'probe', prompt: 'x'.repeat(100001), timeoutMs: 1000 },
    ]) {
      expect(workerInputSchema.safeParse(value).success).toBe(false);
    }
  });

  it('should accept bounded purpose-specific requests only', () => {
    const result = workerInputSchema.safeParse({
      task: 'author',
      prompt: 'Read RULES.md',
      files: { 'RULES.md': 'Rules', 'SCHEMA.json': '{}' },
      timeoutMs: 1000,
      maxTurns: 10,
    });

    expect(result.success).toBe(true);
    // The keeper's request carries a deadline and nothing else: which
    // session to refresh and where to store it are the worker's own.
    expect(
      workerInputSchema.safeParse({
        task: 'refreshSession',
        timeoutMs: 1000,
        minAgeMs: 0,
      }).success,
    ).toBe(true);
    expect(
      workerInputSchema.safeParse({
        task: 'refreshSession',
        timeoutMs: 1000,
        minAgeMs: 0,
        secretArn: 'arn:aws:secretsmanager:eu-north-1:1:secret:x',
      }).success,
    ).toBe(false);
  });

  it('should accept author repair context while preserving separate reviewer notes', () => {
    const result = workerInputSchema.safeParse({
      task: 'author',
      prompt: 'Repair the previous draft using the validation feedback',
      files: {
        'PREVIOUS/config.json': '{}',
        'PREVIOUS/author-notes.json': '{"reasons":["Unverified claim"]}',
        'PREVIOUS/notes.md': 'Retain the approved buyer scope',
      },
      timeoutMs: 1000,
      maxTurns: 10,
    });

    expect(result.success).toBe(true);
  });
});
