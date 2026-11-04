const compareKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
};

/** JSONB can reorder object keys; persisted receipts must hash values, not order. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
};

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

/**
 * strictCanonicalJson is the public canonicalization of audit bundles
 * (specs/aeo-open-source-cli-spec.md §8.1): canonicalJson's bytes on every
 * valid JSON value, with a refusal where canonicalJson silently rewrites
 * (a non-finite number becomes null, an undefined array element an invalid
 * empty slot, a Date or Map an empty object). Keys sort by UTF-16 code
 * units, array order is kept, there is no whitespace.
 */
export const strictCanonicalJson = (value: unknown, at = '$'): string => {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Non-finite number at ${at} has no canonical form.`);
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = Array.from(value, (item: unknown, index) => {
      if (item === undefined) {
        throw new Error(`Undefined array element at ${at}[${index}].`);
      }

      return strictCanonicalJson(item, `${at}[${index}]`);
    });

    return `[${items.join(',')}]`;
  }

  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      throw new Error(`Non-plain object at ${at} has no canonical form.`);
    }

    const members = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${strictCanonicalJson(entry, `${at}.${key}`)}`,
      );

    return `{${members.join(',')}}`;
  }

  throw new Error(`Value of type ${typeof value} at ${at} is not JSON.`);
};
