import { describe, expect, it } from 'vitest';
import { plannedProbeUnitsForSection, probeUnitKey } from '../lib/checkpoint';
import { agentSurfaces, chatSurfaces, type AeoPrompt } from '../schema';
import { runAgentProbesForPrompts } from './agent-clis';
import { runProbesForPrompts } from './probes';

// ============================================================================
// Planner ↔ executor parity: the checkpoint's planned-units list mirrors the
// probe batches' own fan-out loops. If either side drifts, cache matching
// silently corrupts (false misses re-pay probes; false hits serve stale
// answers). These tests drive each executor with a record-and-reject filter —
// every candidate unit is offered to the filter before anything would run,
// so the executors' true fan-out is observable without a single probe call.
// ============================================================================

const section = 'section_a';
const prompts: AeoPrompt[] = [
  { id: 'p1', text: 'First prompt?', category: 'comparison' },
  { id: 'p2', text: 'Second prompt?', category: 'problem_solving' },
];

const promptInputs = prompts.map((p) => ({
  id: p.id,
  promptText: p.text,
  category: p.category,
}));

describe('probes - probe batch plan parity', () => {
  it('should offer exactly the planned chat units in the chat batch', async () => {
    const offered = new Set<string>();
    const results = await runProbesForPrompts({
      geography: 'us',
      language: 'en',
      prompts: promptInputs,
      surfaces: chatSurfaces,
      chatProbes: undefined,
      // Nothing is dispatched: every unit is refused by the filter.
      dependencies: { gateway: () => 'unused' },
      filter: (unit) => {
        offered.add(probeUnitKey({ sectionKey: section, ...unit }));

        return false;
      },
    });

    const planned = plannedProbeUnitsForSection({
      sectionKey: section,
      prompts,
      surfaces: chatSurfaces,
      agentProbes: { runsPerPrompt: 2 },
      chatProbes: undefined,
    });

    expect(results).toEqual([]);
    expect(offered).toEqual(new Set(planned.map(probeUnitKey)));
    // 2 prompts × (2+2+2+2+1) canonical chat runs.
    expect(offered.size).toBe(18);
  });

  it('should offer exactly the planned chat units at a configured chat depth', async () => {
    const chatProbes = { runsPerPrompt: 3 };
    const offered = new Set<string>();
    const results = await runProbesForPrompts({
      geography: 'us',
      language: 'en',
      prompts: promptInputs,
      surfaces: chatSurfaces,
      chatProbes,
      // Nothing is dispatched: every unit is refused by the filter.
      dependencies: { gateway: () => 'unused' },
      filter: (unit) => {
        offered.add(probeUnitKey({ sectionKey: section, ...unit }));

        return false;
      },
    });

    const planned = plannedProbeUnitsForSection({
      sectionKey: section,
      prompts,
      surfaces: chatSurfaces,
      agentProbes: { runsPerPrompt: 2 },
      chatProbes,
    });

    expect(results).toEqual([]);
    expect(offered).toEqual(new Set(planned.map(probeUnitKey)));
    // 2 prompts × 3 runs × 5 chat surfaces, AI Overview included.
    expect(offered.size).toBe(30);
  });

  it('should offer exactly the planned agent units in the agent batch, cap and runs included', async () => {
    const agentProbes = { runsPerPrompt: 2, maxPromptsPerSection: 1 };
    const offered = new Set<string>();
    const { outcomes, rejectedWebToolSurfaces } =
      await runAgentProbesForPrompts({
        // The pipeline's convention: the caller slices the prompt subset.
        prompts: promptInputs.slice(0, agentProbes.maxPromptsPerSection),
        surfaces: agentSurfaces,
        versions: { claudeCode: 'test', codex: 'test', cursor: 'test' },
        runsPerPrompt: agentProbes.runsPerPrompt,
        filter: (unit) => {
          offered.add(probeUnitKey({ sectionKey: section, ...unit }));

          return false;
        },
      });

    const planned = plannedProbeUnitsForSection({
      sectionKey: section,
      prompts,
      surfaces: agentSurfaces,
      agentProbes,
      chatProbes: undefined,
    });

    expect(outcomes).toEqual([]);
    expect(rejectedWebToolSurfaces).toEqual([]);
    expect(offered).toEqual(new Set(planned.map(probeUnitKey)));
    // 1 capped prompt × 2 runs × 3 CLIs.
    expect(offered.size).toBe(6);
  });
});
