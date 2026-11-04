/**
 * requireDefined narrows a value that a test's arrange step guarantees, such
 * as the first item of a fixture list, and fails the test by name when the
 * guarantee breaks.
 */
export const requireDefined = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) {
    throw new Error(`Expected test value to be defined: ${name}.`);
  }

  return value;
};
