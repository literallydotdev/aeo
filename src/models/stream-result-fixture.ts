const readField = (settled: unknown, key: string): unknown => {
  return typeof settled === 'object' && settled !== null
    ? Reflect.get(settled, key)
    : undefined;
};

/**
 * streamedResult is test support: it adapts one settled answer into the
 * streaming surface the gateway transport consumes.
 *
 * The transport streams, because the gateway abandons a non-streaming request
 * at 340 seconds. Tests still want to describe a single finished answer, so
 * this wraps that answer's fields in promise-like members. A field that throws
 * when read becomes a rejected member rather than a synchronous throw, which
 * is how streaming reports that nothing matched the response schema: the
 * output promise rejects with NoObjectGeneratedError while every sibling
 * member resolves normally.
 */
export const streamedResult = (answer: unknown) => {
  const createMember = <T>(read: (settled: unknown) => T) => {
    return {
      then: (
        onFulfilled?: ((value: T) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) =>
        Promise.resolve(answer)
          .then((settled: unknown) => read(settled))
          .then(onFulfilled, onRejected),
    };
  };

  const result = {
    output: createMember((settled) => readField(settled, 'output')),
    text: createMember((settled) => readField(settled, 'text')),
    usage: createMember((settled) => readField(settled, 'usage')),
    response: createMember((settled) => readField(settled, 'response')),
    finishReason: createMember((settled) => readField(settled, 'finishReason')),
    providerMetadata: createMember((settled) =>
      readField(settled, 'providerMetadata'),
    ),
    toolCalls: createMember((settled) => readField(settled, 'toolCalls') ?? []),
  };

  return result;
};
