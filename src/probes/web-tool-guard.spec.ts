import { describe, expect, it } from 'vitest';
import {
  webToolGuardMinAnswers,
  checkCoverage,
  checkRetrievalCapture,
  checkWebToolDetection,
  checkWebToolParse,
} from './web-tool-guard';

const repeat = <T>(value: T, count: number): T[] => {
  return Array.from({ length: count }, () => value);
};

const rows = (
  surface: string,
  flags: Array<boolean | null | undefined>,
): Array<{ surface: string; usedWebSearch: boolean | null | undefined }> => {
  return flags.map((usedWebSearch) => ({ surface, usedWebSearch }));
};

describe('web-tool-guard - checkWebToolDetection()', () => {
  it('should record a partial failure when a large batch shows zero web tool use', () => {
    const failures = checkWebToolDetection(
      rows('claude_code', repeat(false, webToolGuardMinAnswers)),
    );

    expect(failures).toEqual([
      {
        step: 'probes:web_tool_detection:claude_code',
        error: `0/${webToolGuardMinAnswers} answers show web tool use; verify detection against the installed CLI`,
      },
    ]);
  });

  it('should stay quiet when even one answer searched', () => {
    const flags = repeat(false, webToolGuardMinAnswers);
    flags[3] = true;
    expect(checkWebToolDetection(rows('cursor', flags))).toEqual([]);
  });

  it('should ignore batches under the size threshold', () => {
    expect(
      checkWebToolDetection(
        rows('codex', repeat(false, webToolGuardMinAnswers - 1)),
      ),
    ).toEqual([]);
  });

  it('should NOT count unknown (null) rows toward the batch', () => {
    const flags = [...repeat(false, webToolGuardMinAnswers - 1), null, null];

    expect(checkWebToolDetection(rows('claude_code', flags))).toEqual([]);
  });

  it('should check each agent surface independently and ignore chat surfaces', () => {
    const failures = checkWebToolDetection([
      ...rows('claude_code', repeat(false, 10)),
      ...rows('codex', repeat(true, 10)),
      ...rows('chatgpt', repeat(undefined, 10)),
    ]);

    expect(failures.map((f) => f.step)).toEqual([
      'probes:web_tool_detection:claude_code',
    ]);
  });
});

describe('web-tool-guard - checkRetrievalCapture()', () => {
  const fresh = (surface: string, calls: Array<number | null>) => {
    return calls.map((retrievalCalls) => ({ surface, retrievalCalls }));
  };

  it('should record a partial failure when a full chat surface captured many rows and none carries a log', () => {
    expect(
      checkRetrievalCapture(
        fresh('chatgpt', repeat(null, webToolGuardMinAnswers)),
      ),
    ).toEqual([
      {
        step: 'probes:retrieval_capture:chatgpt',
        error: `0/${webToolGuardMinAnswers} answers captured by this run carry a retrieval log; verify the extractor against the installed AI SDK`,
      },
    ]);
  });

  it('should stay quiet when even one fresh row carries a non-empty log', () => {
    const calls = repeat<number | null>(null, webToolGuardMinAnswers);
    calls[2] = 3;
    expect(checkRetrievalCapture(fresh('claude', calls))).toEqual([]);
  });

  it('should ignore batches under the size threshold and non-full surfaces', () => {
    expect(
      checkRetrievalCapture([
        ...fresh('claude', repeat(null, webToolGuardMinAnswers - 1)),
        ...fresh('gemini', repeat(null, 20)),
        ...fresh('perplexity', repeat(0, 20)),
        ...fresh('claude_code', repeat(null, 20)),
      ]),
    ).toEqual([]);
  });
});

describe('web-tool-guard - checkWebToolParse()', () => {
  it('should record a partial failure when every fresh capture has unknown retrieval', () => {
    const rows = Array.from({ length: webToolGuardMinAnswers }, () => ({
      surface: 'claude_code',
      usedWebSearch: null,
    }));

    expect(checkWebToolParse(rows).map((f) => f.step)).toEqual([
      'probes:web_tool_parse:claude_code',
    ]);
  });

  it('should stay quiet when one row is known, or under the size threshold', () => {
    const rows = Array.from({ length: webToolGuardMinAnswers }, (_, index) => ({
      surface: 'codex',
      usedWebSearch: index === 0 ? false : null,
    }));

    expect(checkWebToolParse(rows)).toEqual([]);
    expect(
      checkWebToolParse(
        rows.slice(1).map((r) => ({ ...r, usedWebSearch: null })),
      ),
    ).toEqual([]);
  });
});

describe('web-tool-guard - checkCoverage()', () => {
  const thresholds = { blockAtZero: true, minCapturedRatio: 0.5 };

  it('should block a surface at zero and a surface below the ratio', () => {
    const failures = checkCoverage(
      [
        { surface: 'claude_code', planned: 20, captured: 0 },
        { surface: 'codex', planned: 20, captured: 9 },
        { surface: 'cursor', planned: 20, captured: 10 },
        { surface: 'chatgpt', planned: 0, captured: 0 },
      ],
      thresholds,
    );

    expect(failures.map((f) => f.step)).toEqual([
      'probes:coverage:claude_code',
      'probes:coverage:codex',
    ]);

    expect(failures[0]?.error).toContain('0/20');
  });

  it('should honor lowered thresholds', () => {
    expect(
      checkCoverage([{ surface: 'codex', planned: 20, captured: 1 }], {
        blockAtZero: true,
        minCapturedRatio: 0,
      }),
    ).toEqual([]);

    expect(
      checkCoverage([{ surface: 'codex', planned: 20, captured: 0 }], {
        blockAtZero: false,
        minCapturedRatio: 0,
      }),
    ).toEqual([]);
  });
});
