import { describe, expect, it } from 'vitest';
import type { AeoPrompt } from '../schema';
import {
  plannedProbeUnitsForSection,
  probeUnitKey,
  unitRecordKey,
  type ProbeUnit,
} from './checkpoint';

const promptsFixture: AeoPrompt[] = [
  { id: 'p1', text: 'What are the best tools?', category: 'comparison' },
  { id: 'p2', text: 'Who are the main players?', category: 'industry_expert' },
];

const createUnit = (overrides: Partial<ProbeUnit> = {}): ProbeUnit => {
  return {
    sectionKey: 'section_a',
    promptId: 'p1',
    promptText: 'What are the best tools?',
    surface: 'claude',
    runIndex: 1,
    ...overrides,
  };
};

describe('checkpoint - plannedProbeUnitsForSection()', () => {
  it('should plan chat surfaces at canonical run counts and agents at configured volume', () => {
    const units = plannedProbeUnitsForSection({
      sectionKey: 'section_a',
      prompts: promptsFixture,
      surfaces: ['claude', 'google_ai_overview', 'claude_code'],
      agentProbes: { runsPerPrompt: 2 },
      chatProbes: undefined,
    });

    // Claude 2 runs, google_ai_overview 1 run and claude_code 2 runs make 5 per prompt.
    expect(units).toHaveLength(10);
    expect(
      units.filter((u) => u.surface === 'google_ai_overview'),
    ).toHaveLength(2);
    expect(units.filter((u) => u.surface === 'claude_code')).toHaveLength(4);
  });

  it('should plan every chat surface at a configured chat depth, AI Overview included', () => {
    const units = plannedProbeUnitsForSection({
      sectionKey: 'section_a',
      prompts: promptsFixture,
      surfaces: ['claude', 'google_ai_overview', 'claude_code'],
      agentProbes: { runsPerPrompt: 3 },
      chatProbes: { runsPerPrompt: 12 },
    });

    const aiOverviewRuns = units
      .filter((u) => u.surface === 'google_ai_overview' && u.promptId === 'p1')
      .map((u) => u.runIndex);

    // 2 prompts × (12 claude + 12 AI Overview + 3 claude_code).
    expect(units).toHaveLength(54);
    expect(aiOverviewRuns).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(units.filter((u) => u.surface === 'claude_code')).toHaveLength(6);
  });

  it('should cap agent prompts at maxPromptsPerSection without touching chat coverage', () => {
    const units = plannedProbeUnitsForSection({
      sectionKey: 'section_a',
      prompts: promptsFixture,
      surfaces: ['claude', 'codex'],
      agentProbes: { runsPerPrompt: 1, maxPromptsPerSection: 1 },
      chatProbes: undefined,
    });

    const agentUnits = units.filter((u) => u.surface === 'codex');

    expect(units.filter((u) => u.surface === 'claude')).toHaveLength(4);
    expect(agentUnits).toHaveLength(1);
    expect(agentUnits[0]?.promptId).toBe('p1');
  });
});

describe('checkpoint - probeUnitKey() and unitRecordKey()', () => {
  it('should distinguish every dimension in probeUnitKey', () => {
    const base = createUnit();
    const keys = new Set([
      probeUnitKey(base),
      probeUnitKey({ ...base, sectionKey: 'other' }),
      probeUnitKey({ ...base, surface: 'codex' }),
      probeUnitKey({ ...base, promptId: 'p2' }),
      probeUnitKey({ ...base, runIndex: 2 }),
    ]);

    expect(keys.size).toBe(5);
  });

  it('should keep control characters out of keys (they are Postgres text columns)', () => {
    expect(unitRecordKey(createUnit())).not.toMatch(/[\u0000-\u001f]/);
    expect(unitRecordKey(createUnit())).toBe(
      `section_a|claude|p1|1|${unitRecordKey(createUnit()).split('|').at(-1)}`,
    );
  });

  it('should miss in unitRecordKey when the prompt text was edited (baseline reset semantics)', () => {
    expect(unitRecordKey(createUnit())).toBe(unitRecordKey(createUnit()));
    expect(unitRecordKey(createUnit({ promptText: 'Edited prompt' }))).not.toBe(
      unitRecordKey(createUnit()),
    );
  });
});
