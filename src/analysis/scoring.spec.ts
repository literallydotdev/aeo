import { describe, expect, it } from 'vitest';
import { agentSurfaces, chatSurfaces } from '../schema';
import type { AnalyzedProbeForScoring } from './scoring';
import { computeAISearchSummary } from './scoring';

const standardDepth = {
  agentProbes: { runsPerPrompt: 2 },
  chatProbes: undefined,
};

const singleAgentRunDepth = {
  agentProbes: { runsPerPrompt: 1 },
  chatProbes: undefined,
};

const result = (
  overrides: Partial<AnalyzedProbeForScoring>,
): AnalyzedProbeForScoring => {
  return {
    model: 'chatgpt',
    promptId: 'p1',
    clientMentioned: false,
    clientCited: false,
    competitorMentions: [],
    allMentionedBrands: [],
    ...overrides,
  };
};

describe('scoring - computeAISearchSummary()', () => {
  it('should use planned-run denominators for the scoped surfaces (chat: 9/prompt)', () => {
    // 1 prompt × 9 planned chat runs; 3 captured, 3 mentioned → 3/9.
    const summary = computeAISearchSummary({
      clientDomain: 'acme.example',
      competitorDomains: ['rival.example'],
      prompts: [{ id: 'p1', category: 'comparison' }],
      results: [
        result({ clientMentioned: true }),
        result({ model: 'claude', clientMentioned: true, clientCited: true }),
        result({ model: 'gemini', clientMentioned: true }),
      ],
      surfaces: chatSurfaces,
      depth: standardDepth,
    });

    expect(summary.totalPrompts).toBe(9);
    expect(summary.probeShareOfVoice).toBeCloseTo((3 / 9) * 100);
    expect(summary.probeCitationRate).toBeCloseTo((1 / 9) * 100);

    // byModel covers exactly the scoped surfaces.
    expect(Object.keys(summary.byModel).sort()).toEqual(
      [...chatSurfaces].sort(),
    );
  });

  it('should score the agent surfaces on their own planned denominator (2 runs × 3 CLIs)', () => {
    const summary = computeAISearchSummary({
      clientDomain: 'acme.example',
      competitorDomains: [],
      prompts: [{ id: 'p1', category: 'comparison' }],
      results: [
        result({ model: 'claude_code', clientMentioned: true }),
        result({ model: 'codex' }),
      ],
      surfaces: agentSurfaces,
      depth: standardDepth,
    });

    expect(summary.totalPrompts).toBe(6);
    expect(summary.probeShareOfVoice).toBeCloseTo((1 / 6) * 100);
    expect(Object.keys(summary.byModel).sort()).toEqual([
      'claude_code',
      'codex',
      'cursor',
    ]);
  });

  it('should honor a configured agent depth in the denominator', () => {
    // 3 agent-probed prompts × 1 run × 3 surfaces = 9 planned; 2 mentioned.
    const summary = computeAISearchSummary({
      clientDomain: 'acme.example',
      competitorDomains: [],
      prompts: [
        { id: 'p1', category: 'comparison' },
        { id: 'p2', category: 'comparison' },
        { id: 'p3', category: 'comparison' },
      ],
      results: [
        result({ model: 'claude_code', clientMentioned: true }),
        result({ model: 'codex', promptId: 'p2', clientMentioned: true }),
      ],
      surfaces: agentSurfaces,
      depth: singleAgentRunDepth,
    });

    expect(summary.totalPrompts).toBe(9);
    expect(summary.probeShareOfVoice).toBeCloseTo((2 / 9) * 100);
  });

  it('should divide every chat surface by the configured chat depth', () => {
    // 1 prompt × 12 runs × 5 chat surfaces = 60 planned, AI Overview
    // included: a configured depth replaces its single canonical run.
    const summary = computeAISearchSummary({
      clientDomain: 'acme.example',
      competitorDomains: [],
      prompts: [{ id: 'p1', category: 'comparison' }],
      results: [
        result({ clientMentioned: true }),
        result({ model: 'google_ai_overview', clientMentioned: true }),
      ],
      surfaces: chatSurfaces,
      depth: {
        agentProbes: { runsPerPrompt: 2 },
        chatProbes: { runsPerPrompt: 12 },
      },
    });

    expect(summary.totalPrompts).toBe(60);
    expect(summary.probeShareOfVoice).toBeCloseTo((2 / 60) * 100);
    expect(summary.byModel.google_ai_overview?.sov).toBeCloseTo((1 / 12) * 100);
  });

  it('should divide byModel by planned runs per surface, not captured runs (§3.5)', () => {
    // 2 prompts; chatgpt plans 2 runs each = 4, captured 2 of them, both
    // mentioned → 2/4, not 2/2. google_ai_overview plans 1 run each = 2.
    const summary = computeAISearchSummary({
      clientDomain: 'acme.example',
      competitorDomains: [],
      prompts: [
        { id: 'p1', category: 'comparison' },
        { id: 'p2', category: 'comparison' },
      ],
      results: [
        result({ clientMentioned: true, clientCited: true }),
        result({ promptId: 'p2', clientMentioned: true }),
        result({ model: 'google_ai_overview', clientMentioned: true }),
      ],
      surfaces: chatSurfaces,
      depth: standardDepth,
    });

    expect(summary.byModel.chatgpt).toEqual({ sov: 50, citation: 25 });
    expect(summary.byModel.google_ai_overview).toEqual({
      sov: 50,
      citation: 0,
    });
    expect(summary.byModel.claude).toEqual({ sov: 0, citation: 0 });
  });

  it('should honor a capped agent plan and captured < planned in byModel', () => {
    // 3 agent prompts × 1 run: claude_code captured 2 (1 mentioned) → 1/3;
    // cursor captured nothing → 0/3, never a silent 0/0.
    const summary = computeAISearchSummary({
      clientDomain: 'acme.example',
      competitorDomains: [],
      prompts: [
        { id: 'p1', category: 'comparison' },
        { id: 'p2', category: 'comparison' },
        { id: 'p3', category: 'comparison' },
      ],
      results: [
        result({ model: 'claude_code', clientMentioned: true }),
        result({ model: 'claude_code', promptId: 'p2' }),
      ],
      surfaces: agentSurfaces,
      depth: singleAgentRunDepth,
    });

    expect(summary.byModel.claude_code?.sov).toBeCloseTo((1 / 3) * 100);
    expect(summary.byModel.cursor).toEqual({ sov: 0, citation: 0 });
  });

  it('should keep byCategory a ratio within captured runs', () => {
    const summary = computeAISearchSummary({
      clientDomain: 'acme.example',
      competitorDomains: [],
      prompts: [
        { id: 'p1', category: 'comparison' },
        { id: 'p2', category: 'problem_solving' },
      ],
      results: [
        result({ clientMentioned: true }),
        result({ model: 'claude' }),
        result({ model: 'gemini', promptId: 'p2', clientMentioned: true }),
      ],
      surfaces: chatSurfaces,
      depth: standardDepth,
    });

    expect(summary.byCategory.comparison?.sov).toBe(50);
    expect(summary.byCategory.problem_solving?.sov).toBe(100);
  });

  it('should exclude unanalyzed prompts when the caller narrows the prompt list', () => {
    // The pipeline passes only analyzed prompts: 1 of 2 prompts analyzed,
    // so the denominator is 9 (one prompt's chat plan), not 18.
    const summary = computeAISearchSummary({
      clientDomain: 'acme.example',
      competitorDomains: [],
      prompts: [{ id: 'p1', category: 'comparison' }],
      results: [result({ clientMentioned: true })],
      surfaces: chatSurfaces,
      depth: standardDepth,
    });

    expect(summary.totalPrompts).toBe(9);
    expect(summary.probeShareOfVoice).toBeCloseTo((1 / 9) * 100);
  });

  it('should let missing captures lower share of voice instead of hiding them', () => {
    const summary = computeAISearchSummary({
      clientDomain: 'acme.example',
      competitorDomains: [],
      prompts: [
        { id: 'p1', category: 'comparison' },
        { id: 'p2', category: 'comparison' },
      ],
      results: [result({ clientMentioned: true })],
      surfaces: chatSurfaces,
      depth: standardDepth,
    });

    expect(summary.totalPrompts).toBe(18);
    expect(summary.probeShareOfVoice).toBeCloseTo((1 / 18) * 100);
  });
});
