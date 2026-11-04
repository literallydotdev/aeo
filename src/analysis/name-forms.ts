// ============================================================================
// How two product names relate. The competitor classifier merges candidates
// with these, the analyzer reconciles the prospect's own names with them,
// and the Codex workflow canonicalises qualified names across batches with
// them: one definition, so the three never disagree on what "the same
// product" means.
// ============================================================================

/**
 * normalizedBrandName returns one key per name: trimmed, lower-cased, inner
 * whitespace collapsed.
 */
export const normalizedBrandName = (name: string): string => {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
};

/**
 * isBrandOfProduct tells whether a name is the brand of a product. "Netlify" is
 * the brand of "Netlify Functions": the product name starts with the brand name
 * as whole words.
 */
export const isBrandOfProduct = (brand: string, product: string): boolean => {
  const left = brand.trim().toLowerCase();
  const right = product.trim().toLowerCase();

  return right.length > left.length && right.startsWith(`${left} `);
};

/**
 * isShortFormOf tells whether a name is the short form of another. "Cloud Run"
 * is the short form of "Google Cloud Run": the full name ends with the short
 * one as whole words. The pair was qualified twice in one row (run C,
 * 2026-09-13).
 */
export const isShortFormOf = (short: string, full: string): boolean => {
  const left = short.trim().toLowerCase();
  const right = full.trim().toLowerCase();

  return right.length > left.length && right.endsWith(` ${left}`);
};

/**
 * isAcronymLabelOf tells whether a label abbreviates a full name. "GCF 2nd Gen"
 * names "Google Cloud Functions": the label's first word is the initials of the
 * full name, and the rest is a version or edition. The same product twice was
 * refused as an inflated competitor count (run A, 2026-09-13).
 */
export const isAcronymLabelOf = (label: string, fullName: string): boolean => {
  const words = fullName.trim().split(/\s+/);

  if (words.length < 2) {
    return false;
  }

  const initials = words.map((word) => word.charAt(0).toLowerCase()).join('');
  const [first, ...rest] = label.trim().toLowerCase().split(/\s+/);

  return first === initials && rest.length > 0;
};
