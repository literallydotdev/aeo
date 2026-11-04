import { describe, expect, it } from 'vitest';
import {
  isAcronymLabelOf,
  isBrandOfProduct,
  isShortFormOf,
  normalizedBrandName,
} from './name-forms';

describe('name-forms - name form helpers', () => {
  it('should key a name by its words alone', () => {
    expect(normalizedBrandName('  Google   Cloud Run ')).toBe(
      'google cloud run',
    );
  });

  it('should tell a brand from its product, a short form from its full form, an acronym label from its name', () => {
    expect(isBrandOfProduct('Netlify', 'Netlify Functions')).toBe(true);
    expect(isBrandOfProduct('Netlify', 'Netlifyx')).toBe(false);
    expect(isShortFormOf('Cloud Run', 'Google Cloud Run')).toBe(true);
    expect(isShortFormOf('Run', 'Google Cloud Run')).toBe(true);
    expect(isShortFormOf('Cloud', 'Google Cloud Run')).toBe(false);
    expect(isAcronymLabelOf('GCF 2nd Gen', 'Google Cloud Functions')).toBe(
      true,
    );
    expect(isAcronymLabelOf('GCF', 'Google Cloud Functions')).toBe(false);
  });
});
