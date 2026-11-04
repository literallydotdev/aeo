/**
 * hasErrorCode tells whether a failed Node.js call rejected with the given
 * system error code, such as `ENOENT` or `EEXIST`.
 */
export const hasErrorCode = (error: unknown, code: string): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
};
