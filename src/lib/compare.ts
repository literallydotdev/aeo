/** Orders strings by UTF-16 code units, independent of the host's locale:
 * the order canonical output is written in. */
export const compareCodeUnits = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};
