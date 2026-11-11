import { assert, describe, expect, it } from 'vitest';
import { selectProgressMeasurements } from '../lib/progress-comparison';
import {
  parseProgressMeasurement,
  type ProgressMeasurement,
} from './progress-schema';

const fixture = (): ProgressMeasurement => {
  return {
    version: 1,
    runId: 'run-1',
    publishedAt: null,
    captureWindow: {
      start: '2026-09-09T12:00:00.000Z',
      end: '2026-09-09T12:01:00.000Z',
    },
    measurementId: 'a'.repeat(64),
    state: 'independent',
    warnings: [],
    reusedCaptures: 0,
    brandIdentity: 'b'.repeat(64),
    geography: 'us',
    language: 'en',
    analyzer: { version: 4, model: 'openai/gpt-6-astra' },
    slots: [
      {
        sectionKey: 'content',
        questionKey: 'c'.repeat(64),
        surface: 'claude',
        runIndex: 1,
        captured: true,
        analyzed: true,
        citationObserved: true,
        captureId: 'd'.repeat(64),
        mentioned: true,
        cited: false,
        requestedModel: 'observed/model',
        cliVersion: null,
        collectionMethodDigest: 'e'.repeat(64),
        collectionMetadataKnown: true,
      },
    ],
  };
};

const getFirstSlot = (point: ProgressMeasurement) => {
  const [slot] = point.slots;

  assert(slot, 'Expected the fixture to carry a slot.');

  return slot;
};

type ExtrasLevel = 'root' | 'slot' | 'analyzer' | 'captureWindow';

const getExtrasTarget = (point: ProgressMeasurement, level: ExtrasLevel) => {
  switch (level) {
    case 'root': {
      return point;
    }
    case 'slot': {
      return getFirstSlot(point);
    }
    case 'analyzer': {
      return point.analyzer;
    }
    case 'captureWindow': {
      return point.captureWindow;
    }
    default: {
      const unhandled: never = level;

      throw new Error(`Unhandled extras level: ${String(unhandled)}.`);
    }
  }
};

describe('progress-schema - parseProgressMeasurement()', () => {
  it('should round trip the exact public projection and preserve the null date for trusted ledger overlay', () => {
    const stored = fixture();

    const parsed = parseProgressMeasurement(
      JSON.parse(JSON.stringify(stored)),
      'run-1',
    );

    expect(parsed).toEqual(stored);
    expect(stored.publishedAt).toBeNull();
  });

  it('should accept an optional display name without changing older stored projections', () => {
    const stored = fixture();

    const unnamed = parseProgressMeasurement(stored, stored.runId);
    const named = parseProgressMeasurement(
      { ...stored, questionSetName: 'DORA metrics' },
      stored.runId,
    );

    expect(unnamed).not.toHaveProperty('questionSetName');
    expect(named.questionSetName).toBe('DORA metrics');
  });

  it.each(['', '   ', 'x'.repeat(121), 42])(
    'should reject the invalid display name %j',
    (questionSetName) => {
      const stored = fixture();

      const parse = () => {
        return parseProgressMeasurement(
          { ...stored, questionSetName },
          stored.runId,
        );
      };

      expect(parse).toThrow('Invalid stored progress measurement');
    },
  );

  it('should order valid capture dates by time even when fractional-second formats differ', () => {
    const earlier = fixture();
    earlier.runId = 'z-earlier';
    earlier.captureWindow = {
      start: '2026-09-09T12:00:00Z',
      end: '2026-09-09T12:00:00Z',
    };
    const later = fixture();
    later.runId = 'a-later';
    later.measurementId = 'f'.repeat(64);
    later.captureWindow = {
      start: '2026-09-09T12:00:00.001Z',
      end: '2026-09-09T12:00:00.001Z',
    };

    const selected = selectProgressMeasurements([
      parseProgressMeasurement(later, later.runId),
      parseProgressMeasurement(earlier, earlier.runId),
    ]);

    expect(selected.map((point) => point.runId)).toEqual([
      'z-earlier',
      'a-later',
    ]);
  });

  it('should preserve explicit unknown legacy metadata without inventing collection or capture identities', () => {
    const source = fixture();
    const point: ProgressMeasurement = {
      ...source,
      state: 'legacy',
      warnings: [
        'historical_capture_metadata_unknown',
        'collection_metadata_unknown',
      ],
      captureWindow: { start: null, end: null },
      measurementId: null,
      analyzer: { version: null, model: null },
      slots: [
        {
          ...getFirstSlot(source),
          captureId: null,
          requestedModel: null,
          collectionMethodDigest: null,
          collectionMetadataKnown: false,
        },
      ],
    };

    const parsed = parseProgressMeasurement(point, point.runId);

    expect(parsed).toEqual(point);
  });

  it('should reject a valid projection belonging to a different run', () => {
    const point = fixture();

    const parse = () => {
      return parseProgressMeasurement(point, 'another-run');
    };

    expect(parse).toThrow('belongs to another run');
  });

  it.each(['root', 'slot', 'analyzer', 'captureWindow'] as const)(
    'should reject private extras at %s without echoing their values',
    (level) => {
      const point = fixture();
      Object.assign(getExtrasTarget(point, level), {
        rawText: 'PRIVATE-PROMPT-AND-API-SECRET',
      });

      const parse = () => {
        return parseProgressMeasurement(point, point.runId);
      };

      expect(parse).toThrow(/^Invalid stored progress measurement$/);
      expect(parse).not.toThrow(/PRIVATE-PROMPT/);
    },
  );

  it.each([
    ['version', 3],
    ['runId', '../private'],
    ['measurementId', 'bad-digest'],
    ['brandIdentity', 'bad-digest'],
    ['reusedCaptures', -1],
    ['reusedCaptures', 2],
    ['state', 'published'],
    ['warnings', ['private raw provider message']],
  ] as const)('should reject invalid %s', (field, value) => {
    const point = { ...fixture(), [field]: value };

    const parse = () => {
      return parseProgressMeasurement(point, 'run-1');
    };

    expect(parse).toThrow('Invalid stored progress measurement');
  });

  it('should hold a custom surface only as version 2', () => {
    const point = fixture();
    const [slot] = point.slots;
    const custom = { ...point, slots: [{ ...slot, surface: 'custom:grok' }] };

    expect(
      parseProgressMeasurement({ ...custom, version: 2 }, 'run-1').slots[0]
        ?.surface,
    ).toBe('custom:grok');
    expect(() => parseProgressMeasurement(custom, 'run-1')).toThrow(
      'Invalid stored progress measurement',
    );
    // An ID that is neither built in nor a custom one is no surface.
    expect(() =>
      parseProgressMeasurement(
        {
          ...custom,
          version: 2,
          slots: [{ ...slot, surface: 'custom:Not A Key' }],
        },
        'run-1',
      ),
    ).toThrow('Invalid stored progress measurement');
  });

  it('should hold a consumer app only as version 2', () => {
    const point = fixture();
    const [slot] = point.slots;
    const scraped = { ...point, slots: [{ ...slot, surface: 'chatgpt_app' }] };

    expect(
      parseProgressMeasurement({ ...scraped, version: 2 }, 'run-1').slots[0]
        ?.surface,
    ).toBe('chatgpt_app');
    expect(() => parseProgressMeasurement(scraped, 'run-1')).toThrow(
      'Invalid stored progress measurement',
    );
  });

  it.each([
    { runIndex: 0 },
    { runIndex: 1.5 },
    { surface: 'unknown' },
    { questionKey: 'bad-digest' },
    { mentioned: true, analyzed: false },
    { cited: true, citationObserved: false },
    { captured: false },
    { collectionMetadataKnown: false },
    { collectionMethodDigest: null },
  ])('should reject inconsistent or malformed planned slot %j', (mutation) => {
    const point = fixture();
    Object.assign(getFirstSlot(point), mutation);

    const parse = () => {
      return parseProgressMeasurement(point, point.runId);
    };

    expect(parse).toThrow('Invalid stored progress measurement');
  });

  it('should reject duplicate slots', () => {
    const duplicate = fixture();
    duplicate.slots.push({ ...getFirstSlot(duplicate) });

    const parse = () => {
      return parseProgressMeasurement(duplicate, duplicate.runId);
    };

    expect(parse).toThrow();
  });

  it('should reject reversed or half-known capture windows', () => {
    const reversed = fixture();
    reversed.captureWindow = {
      start: '2026-09-09T12:01:00.000Z',
      end: '2026-09-09T12:00:00.000Z',
    };
    const halfKnown = fixture();
    halfKnown.captureWindow = {
      start: '2026-09-09T12:01:00.000Z',
      end: null,
    };

    const parseReversed = () => {
      return parseProgressMeasurement(reversed, reversed.runId);
    };
    const parseHalfKnown = () => {
      return parseProgressMeasurement(halfKnown, halfKnown.runId);
    };

    expect(parseReversed).toThrow();
    expect(parseHalfKnown).toThrow();
  });

  it('should accept real zero outcomes and captured no-overview observations', () => {
    const point = fixture();
    const slot = getFirstSlot(point);
    slot.mentioned = false;
    slot.cited = false;

    const parsed = parseProgressMeasurement(point, point.runId);

    expect(parsed.slots[0]).toMatchObject({
      captured: true,
      analyzed: true,
      mentioned: false,
      cited: false,
    });
  });
});
