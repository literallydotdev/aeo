import { describe, expect, it } from 'vitest';
import {
  formatReportDate,
  reportCopyPresentation,
  reportPreparedBy,
  reportSectionTitle,
} from './report-presentation';

describe('report-presentation - reportSectionTitle()', () => {
  it.each([
    ['aeo agencies', 'AEO agencies'],
    ['AEO and technical content', 'AEO and technical content'],
    ['ai code verification', 'AI code verification'],
    ['Ai code verification', 'AI code verification'],
    ['AI code verification', 'AI code verification'],
    ['ai-powered code review', 'AI-powered code review'],
    ['air traffic', 'Air traffic'],
    ['technical content for API teams', 'Technical content for API teams'],
    ['API documentation', 'API documentation'],
    ['  vector search', '  Vector search'],
    ['évidence and SDKs', 'Évidence and SDKs'],
    ['', ''],
    // Names and acronyms a config key carries in lower case, and a stored
    // title that was sentence-cased before the forms were known.
    ['typescript app hosting', 'TypeScript app hosting'],
    ['Typescript app hosting', 'TypeScript app hosting'],
    ['wysiwyg editors for react', 'WYSIWYG editors for react'],
    ['node.js api hosting', 'Node.js API hosting'],
    ['ci cd pipelines on github', 'CI CD pipelines on GitHub'],
    ['it services for hr teams', 'It services for HR teams'],
    ['stained glass design software', 'Stained glass design software'],
    // A sentence-ending period stays outside the name lookup.
    ['hosting api.', 'Hosting API.'],
    ['managed node.js.', 'Managed Node.js.'],
    // A leading number is the first word; the second word is not capitalized.
    ['2 factor authentication', '2 factor authentication'],
    ['3d printing services', '3d printing services'],
  ])('should format %j without lowercasing names', (input, expected) => {
    expect(reportSectionTitle(input)).toBe(expected);
  });

  it.each([
    ['website constructor tools', 'Website constructor tools'],
    ['constructor tools', 'Constructor tools'],
    ['tostring helpers', 'Tostring helpers'],
    ['string toString helpers', 'String toString helpers'],
    ['website __proto__ tools', 'Website __proto__ tools'],
  ])('should NOT match inherited object members in %j', (input, expected) => {
    expect(reportSectionTitle(input)).toBe(expected);
  });
});

describe('report-presentation - formatReportDate()', () => {
  it.each([
    ['2026-09-01T00:00:00.000Z', '1 September 2026'],
    ['2026-09-01T00:30:00+02:00', '31 August 2026'],
    ['2026-08-31T23:30:00-02:00', '1 September 2026'],
    ['2026-09-01', '1 September 2026'],
  ])('should format %s using the recorded UTC date', (iso, expected) => {
    expect(formatReportDate(iso)).toBe(expected);
  });

  it('should preserve an unparseable legacy date without inventing a replacement', () => {
    expect(formatReportDate('Date unavailable')).toBe('Date unavailable');
  });
});

describe('report-presentation - reportPreparedBy()', () => {
  it('should name the report company and the actual audit date', () => {
    expect(reportPreparedBy('Example.dev', '2026-09-01T14:30:00Z')).toBe(
      'Prepared by Literally.dev for Example.dev, 1 September 2026',
    );
  });
});

describe('report-presentation - reportCopyPresentation()', () => {
  it('should present agent copy as generated', () => {
    expect(reportCopyPresentation('agent')).toBe('generated');
  });

  it.each(['human', 'legacy_baseline_import', null, undefined])(
    'should present %s copy as authored',
    (kind) => {
      expect(reportCopyPresentation(kind)).toBe('authored');
    },
  );
});
