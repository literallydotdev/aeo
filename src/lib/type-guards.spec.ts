import { describe, expect, it } from 'vitest';
import { isObject, isRecord } from './type-guards';

describe('type-guards - isObject()', () => {
  it('should accept objects and arrays', () => {
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject([])).toBe(true);
  });

  it('should NOT accept null or primitives', () => {
    expect(isObject(null)).toBe(false);
    expect(isObject('text')).toBe(false);
    expect(isObject(1)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});

describe('type-guards - isRecord()', () => {
  it('should accept plain objects', () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('should NOT accept arrays, null or primitives', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('text')).toBe(false);
  });
});
