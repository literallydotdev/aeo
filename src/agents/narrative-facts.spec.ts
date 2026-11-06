import { assert, describe, expect, it } from 'vitest';
import configFixture from '../__fixtures__/replay/literally-2026-q3/config.json';
import snapshotFixture from '../__fixtures__/replay/literally-2026-q3/snapshot.json';
import { aeoAuditConfigSchema, aeoSnapshotSchema } from '../schema';
import { contentHash } from '../stores/content-hash';
import { buildNarrativeFacts } from './narrative-facts';

describe('narrative-facts - buildNarrativeFacts()', () => {
  it('should name only captured surfaces, with distinct assistant and coding-agent scope per section', () => {
    const config = aeoAuditConfigSchema.parse(configFixture);
    const snapshot = aeoSnapshotSchema.parse(snapshotFixture);
    const [first, second] = snapshot.sections;
    const row = first?.visibility.matrix[0];

    assert(first && second && row);

    snapshot.meta.surfaces = [
      'chatgpt',
      'claude',
      'gemini',
      'claude_code',
      'codex',
      'cursor',
    ];
    first.visibility.surfaces = snapshot.meta.surfaces;
    second.visibility.surfaces = snapshot.meta.surfaces;
    first.visibility.matrix = [
      { ...row, surface: 'chatgpt' },
      { ...row, surface: 'chatgpt', promptIdx: 1 },
    ];
    second.visibility.matrix = [{ ...row, surface: 'codex' }];

    const facts = buildNarrativeFacts(snapshot, config, 'run-1');

    const aggregate = facts.find(({ factId }) => factId === 'scope:surfaces');

    assert(aggregate);
    expect(aggregate).toMatchObject({
      section: null,
      numerator: 2,
      denominator: null,
    });
    expect(aggregate.sentence).toContain(
      'Captured chat and search assistants: ChatGPT.',
    );
    expect(aggregate.sentence).toContain('Captured coding agents: Codex.');
    expect(aggregate.sentence).not.toContain('Claude');
    expect(aggregate.sentence).not.toContain('Gemini');
    expect(aggregate.sentence).not.toContain('Cursor');

    const firstScope = facts.find(
      ({ factId }) => factId === `scope:${first.key}:surfaces`,
    );

    assert(firstScope);
    expect(firstScope).toMatchObject({ section: first.key, numerator: 1 });
    expect(firstScope.sentence).toContain('Captured coding agents: none.');
    expect(firstScope.sentence).not.toContain('Codex');

    const secondScope = facts.find(
      ({ factId }) => factId === `scope:${second.key}:surfaces`,
    );

    assert(secondScope);
    expect(secondScope.sentence).toContain(
      'Captured chat and search assistants: none.',
    );
    expect(secondScope.sentence).not.toContain('ChatGPT');
  });

  it('should NOT infer captured coverage from planned surfaces when every answer is missing', () => {
    const config = aeoAuditConfigSchema.parse(configFixture);
    const snapshot = aeoSnapshotSchema.parse(snapshotFixture);

    for (const section of snapshot.sections) {
      section.visibility.matrix = [];
    }

    const facts = buildNarrativeFacts(snapshot, config, 'run-1');

    const scope = facts.find(({ factId }) => factId === 'scope:surfaces');

    assert(scope);
    expect(scope.numerator).toBe(0);
    expect(scope.sentence).toContain(
      'Captured chat and search assistants: none.',
    );
    expect(scope.sentence).toContain('Captured coding agents: none.');
  });

  it('should make mention and citation scope explicit without implying an endorsement', () => {
    const config = aeoAuditConfigSchema.parse(configFixture);
    const snapshot = aeoSnapshotSchema.parse(snapshotFixture);

    const facts = buildNarrativeFacts(snapshot, config, 'run-1');

    const definition = facts.find(
      ({ factId }) => factId === 'scope:mentions-citations',
    );

    assert(definition);
    expect(definition).toMatchObject({
      section: null,
      numerator: null,
      denominator: null,
      unit: 'check',
    });
    expect(definition.sentence).toContain(config.brand.domain);
    expect(definition.sentence).toContain('A mention does not require a link');
    expect(definition.sentence).toContain(
      'does not by itself establish a recommendation',
    );
  });

  it('should keep every pre-existing narrative fact byte-identical for retained copy receipts', () => {
    const config = aeoAuditConfigSchema.parse(configFixture);
    const snapshot = aeoSnapshotSchema.parse(snapshotFixture);

    const facts = buildNarrativeFacts(snapshot, config, 'run-1');

    const legacy = facts.filter(
      ({ factId }) =>
        factId.endsWith(':questions') || factId.startsWith('market:'),
    );

    expect(legacy).toHaveLength(22);
    expect(contentHash(legacy)).toBe(
      '3ff179c37efb8259916c82a398fd1ee0cd5232b9dcd5539732e0626aaab99925',
    );
  });

  it('should keep missing answers in the sample and distinguish questions from proven buyer behavior', () => {
    const config = aeoAuditConfigSchema.parse(configFixture);
    const snapshot = aeoSnapshotSchema.parse(snapshotFixture);
    const [section] = snapshot.sections;
    const configured = config.sections.find(({ key }) => key === section?.key);
    const [competitor] = config.competitors;
    const [firstPrompt] = configured?.prompts ?? [];

    assert(section && configured && competitor && firstPrompt);

    section.visibility.surfaces = ['chatgpt', 'gemini'];
    section.visibility.matrix = [
      {
        promptIdx: 0,
        surface: 'chatgpt',
        prospectMentioned: true,
        prospectPosition: 'primary',
        contextSnippet: null,
        citedUrls: [],
        competitors: [{ domain: competitor.domain, mentioned: true }],
      },
    ];

    const facts = buildNarrativeFacts(
      { ...snapshot, sections: [section] },
      config,
      'run-1',
    );

    const scope = facts.find(
      ({ factId }) => factId === `scope:${section.key}:questions`,
    );

    assert(scope);
    expect(scope.sentence).toContain(firstPrompt.text);
    expect(scope.sentence).toContain('not measured search demand');

    const brand = facts.find(
      ({ factId }) => factId === `market:${section.key}:chat:brand:mentions`,
    );

    assert(brand);
    expect(brand).toMatchObject({
      numerator: 1,
      denominator: configured.prompts.length * 4,
    });
    expect(brand.sentence).toContain('1 answers were captured');
    expect(brand.sentence).toContain('not population market share');
    expect(facts.some(({ factId }) => factId.includes(':agents:'))).toBe(false);
  });

  it('should use agent prompt limits and section-specific competitors', () => {
    const config = aeoAuditConfigSchema.parse(configFixture);
    const snapshot = aeoSnapshotSchema.parse(snapshotFixture);
    const [section] = snapshot.sections;
    const configured = config.sections.find(({ key }) => key === section?.key);

    assert(section && configured);

    config.agentProbes.maxPromptsPerSection = 2;
    config.agentProbes.runsPerPrompt = 3;
    configured.competitors = [
      { name: 'Section competitor', domain: 'section.example', aliases: [] },
    ];
    section.visibility.surfaces = ['claude_code', 'codex'];
    section.visibility.matrix = [
      {
        promptIdx: 0,
        surface: 'codex',
        prospectMentioned: false,
        prospectPosition: 'absent',
        contextSnippet: null,
        citedUrls: [],
        competitors: [{ domain: 'section.example', mentioned: true }],
      },
    ];

    const facts = buildNarrativeFacts(
      { ...snapshot, sections: [section] },
      config,
      'run-1',
    );

    expect(
      facts.find(
        ({ factId }) =>
          factId === `market:${section.key}:agents:brand:mentions`,
      ),
    ).toMatchObject({ numerator: 0, denominator: 12 });
    expect(
      facts.find(
        ({ factId }) =>
          factId === `market:${section.key}:agents:section.example:mentions`,
      ),
    ).toMatchObject({ numerator: 1, denominator: 12 });
    expect(facts.some(({ factId }) => factId.includes(':chat:'))).toBe(false);
    expect(
      facts.filter(({ factId }) => factId.startsWith('market:')),
    ).toHaveLength(2);
  });

  it('should count chat planned answers at the configured chat depth, AI Overview included', () => {
    const config = aeoAuditConfigSchema.parse({
      ...configFixture,
      chatProbes: { runsPerPrompt: 5 },
    });
    const snapshot = aeoSnapshotSchema.parse(snapshotFixture);
    const [section] = snapshot.sections;
    const configured = config.sections.find(({ key }) => key === section?.key);

    assert(section && configured);

    section.visibility.surfaces = ['claude', 'google_ai_overview'];
    section.visibility.matrix = [];

    const facts = buildNarrativeFacts(
      { ...snapshot, sections: [section] },
      config,
      'run-1',
    );

    // 5 runs on each surface, where the canonical depth plans 2 + 1.
    expect(
      facts.find(
        ({ factId }) => factId === `market:${section.key}:chat:brand:mentions`,
      ),
    ).toMatchObject({
      numerator: 0,
      denominator: configured.prompts.length * 10,
    });
  });
});
