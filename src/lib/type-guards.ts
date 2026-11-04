/**
 * isObject accepts any non-null object, arrays included. It narrows untyped
 * JSON before its fields are read one by one.
 */
export const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

/**
 * isRecord accepts a non-null object that is not an array: a JSON object.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return isObject(value) && !Array.isArray(value);
};
