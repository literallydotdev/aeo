import { describe, expect, it } from 'vitest';
import { qualifiedCompetitorsForRow } from './qualified-competitors';

describe('qualified-competitors - qualifiedCompetitorsForRow()', () => {
  it('should use discovered alternatives without requiring a configured seed', () => {
    expect(
      qualifiedCompetitorsForRow({
        competitors: [{ domain: 'seed.example', mentioned: true }],
        qualifiedCompetitors: [{ name: 'New agency', domain: 'new.example' }],
      }),
    ).toEqual([{ name: 'New agency', domain: 'new.example' }]);
  });

  it('should NOT reintroduce configured seeds after an empty qualification', () => {
    expect(
      qualifiedCompetitorsForRow({
        competitors: [{ domain: 'seed.example', mentioned: true }],
        qualifiedCompetitors: [],
      }),
    ).toEqual([]);
  });

  it('should use only positively mentioned configured competitors for legacy rows', () => {
    expect(
      qualifiedCompetitorsForRow({
        competitors: [
          { domain: 'seed.example', mentioned: true },
          { domain: 'absent.example', mentioned: false },
        ],
      }),
    ).toEqual([{ name: 'seed.example', domain: 'seed.example' }]);
  });
});
