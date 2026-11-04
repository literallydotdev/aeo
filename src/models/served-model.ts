/**
 * servedModelOf reads the model a provider says served a request through the
 * AI SDK. The SDK fills `response.modelId` with the requested model whenever
 * the provider names none, so a value equal to the request proves nothing and
 * is recorded as unknown (specs/aeo-open-source-cli-spec.md §7.1: observed
 * identity is never filled from the requested model). The gateway names the
 * upstream route when it has one: an upstream provider's own name for the
 * model it served.
 */
export const servedModelOf = (
  requestedModel: string,
  responseModelId: string | undefined,
): string | undefined => {
  if (responseModelId === undefined || responseModelId === '') {
    return undefined;
  }

  return responseModelId === requestedModel ? undefined : responseModelId;
};
