import { describe, expect, it } from 'vitest';
import {
  brandIdentityHash,
  codepointCompare,
  perceptionKey,
  type AnalyzerIdentity,
} from './analysis-checkpoint';

const identityFixture: AnalyzerIdentity = {
  brand: { name: 'Acme Files', domain: 'acme.example', aliases: [] },
  competitors: [{ name: 'Other', domain: 'other.example', aliases: [] }],
};

describe('analysis-checkpoint - brandIdentityHash()', () => {
  it('should be order-independent over aliases and competitors', () => {
    const shuffled: AnalyzerIdentity = {
      brand: { ...identityFixture.brand, aliases: ['AcmeFS', 'Acme'] },
      competitors: [
        { name: 'Rival', domain: 'rival.example', aliases: [] },
        ...identityFixture.competitors,
      ],
    };
    const ordered: AnalyzerIdentity = {
      brand: { ...identityFixture.brand, aliases: ['Acme', 'AcmeFS'] },
      competitors: [
        ...identityFixture.competitors,
        { name: 'Rival', domain: 'rival.example', aliases: [] },
      ],
    };

    expect(brandIdentityHash(shuffled)).toBe(brandIdentityHash(ordered));
  });

  it('should miss when a brand alias or a competitor is added', () => {
    expect(
      brandIdentityHash({
        ...identityFixture,
        brand: { ...identityFixture.brand, aliases: ['AcmeFS'] },
      }),
    ).not.toBe(brandIdentityHash(identityFixture));
    expect(
      brandIdentityHash({
        ...identityFixture,
        competitors: [
          ...identityFixture.competitors,
          { name: 'Rival', domain: 'rival.example', aliases: [] },
        ],
      }),
    ).not.toBe(brandIdentityHash(identityFixture));
  });
});

describe('analysis-checkpoint - codepointCompare()', () => {
  it('should order by code point, not locale', () => {
    expect(['b', 'B', 'a', 'ä'].sort(codepointCompare)).toEqual([
      'B',
      'a',
      'b',
      'ä',
    ]);
  });
});

describe('analysis-checkpoint - perceptionKey()', () => {
  const firstAnswer = {
    surface: 'chatgpt',
    runIndex: 1,
    promptIdx: 0,
    text: 'A',
  };
  const secondAnswer = {
    surface: 'codex',
    runIndex: 2,
    promptIdx: 1,
    text: 'B',
  };
  const answers = [firstAnswer, secondAnswer];
  const base = {
    sectionKey: 'smb',
    identity: identityFixture,
    productBrief: 'brief',
    answers,
    perceptionVersion: 1,
  };

  it('should be order-independent over answers and sensitive to the brief and version', () => {
    expect(perceptionKey({ ...base, answers: [...answers].reverse() })).toBe(
      perceptionKey(base),
    );
    expect(perceptionKey({ ...base, productBrief: 'edited' })).not.toBe(
      perceptionKey(base),
    );
    expect(perceptionKey({ ...base, perceptionVersion: 2 })).not.toBe(
      perceptionKey(base),
    );
  });

  it('should miss when an answer text or the brand identity changes, and scope to the section', () => {
    expect(
      perceptionKey({
        ...base,
        answers: [firstAnswer, { ...secondAnswer, text: 'Re-probed answer' }],
      }),
    ).not.toBe(perceptionKey(base));
    expect(
      perceptionKey({
        ...base,
        identity: {
          ...identityFixture,
          brand: { ...identityFixture.brand, aliases: ['AcmeFS'] },
        },
      }),
    ).not.toBe(perceptionKey(base));
    expect(perceptionKey({ ...base, sectionKey: 'other' })).not.toBe(
      perceptionKey(base),
    );
  });
});
