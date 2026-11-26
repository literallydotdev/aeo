import { describe, expect, it } from 'vitest';
import { pipelineRequestSchema, scopeSchema } from './schema';

describe('schema - pipelineRequestSchema run pin', () => {
  const regeneration = {
    reportKey: 'acmebase-2026-q4',
    run: { mode: 'resume', runId: '01HOSTEDRUN000000000000000' },
    copy: 'regenerate',
  };

  it('should accept a run pinned on a copy regeneration', () => {
    const request = pipelineRequestSchema.parse(regeneration);

    expect(request.run.runId).toBe('01HOSTEDRUN000000000000000');
  });

  it('should refuse a pin on a fresh measurement', () => {
    const result = pipelineRequestSchema.safeParse({
      ...regeneration,
      run: { ...regeneration.run, mode: 'fresh' },
    });

    expect(result.success).toBe(false);
  });

  it('should refuse a pin without a copy regeneration', () => {
    const result = pipelineRequestSchema.safeParse({
      ...regeneration,
      copy: 'draft',
    });

    expect(result.success).toBe(false);
  });

  it('should leave an unpinned request unchanged', () => {
    const request = pipelineRequestSchema.parse({
      reportKey: 'acmebase-2026-q4',
    });

    expect(request.run.runId).toBeUndefined();
  });
});

describe('schema - scopeSchema', () => {
  it('should name the import scopes', () => {
    expect(scopeSchema.options).toEqual(
      expect.arrayContaining(['imports:write', 'imports:read']),
    );
  });
});
