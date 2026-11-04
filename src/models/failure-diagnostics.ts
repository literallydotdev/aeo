type FailureClassification =
  'timeout' | 'abort' | 'schema' | 'outputlimit' | 'provider' | 'unclassified';

const errorClasses: Record<string, FailureClassification> = {
  Error: 'unclassified',
  TypeError: 'unclassified',
  RangeError: 'unclassified',
  SyntaxError: 'unclassified',
  AbortError: 'abort',
  TimeoutError: 'timeout',
  ZodError: 'schema',
  AI_NoObjectGeneratedError: 'schema',
  AI_NoOutputGeneratedError: 'schema',
  StructuredOutputMissingError: 'schema',
  AI_TypeValidationError: 'schema',
  AI_JSONParseError: 'schema',
  AI_APICallError: 'provider',
  AI_RetryError: 'provider',
  AI_EmptyResponseBodyError: 'provider',
  AI_InvalidResponseDataError: 'provider',
  AI_NoContentGeneratedError: 'provider',
  AI_LoadAPIKeyError: 'provider',
  AI_LoadSettingError: 'provider',
  AI_NoSuchModelError: 'provider',
  GatewayAuthenticationError: 'provider',
  GatewayForbiddenError: 'provider',
  GatewayInvalidRequestError: 'provider',
  GatewayModelNotFoundError: 'provider',
  GatewayRateLimitError: 'provider',
  GatewayInternalServerError: 'provider',
  GatewayFailedDependencyError: 'provider',
  GatewayResponseError: 'provider',
  GatewayTimeoutError: 'timeout',
};

const timeoutCodes = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const networkCodes = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
]);

const field = (value: unknown, key: string): unknown => {
  try {
    return value !== null && typeof value === 'object'
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    // Diagnostics cannot replace the original error if an error field is a getter.
    return undefined;
  }
};

const safeClass = (error: unknown): string => {
  const name = field(error, 'name');

  if (typeof name === 'string' && Object.hasOwn(errorClasses, name)) {
    return name;
  }

  try {
    return error instanceof Error ? 'Error' : 'NonError';
  } catch {
    return 'NonError';
  }
};

/** Only allowlisted labels and a numeric HTTP status can leave an error object. */
export const structuredFailureDiagnostic = (
  error: unknown,
  signal?: AbortSignal,
): {
  classification: FailureClassification;
  errorClass: string;
  httpStatus?: number;
} => {
  const chain: unknown[] = [];
  let current = error;

  while (
    current !== undefined &&
    chain.length < 4 &&
    !chain.includes(current)
  ) {
    chain.push(current);
    current = field(current, 'cause');
  }

  let httpStatus: number | undefined;

  for (const entry of chain) {
    for (const status of [field(entry, 'statusCode'), field(entry, 'status')]) {
      if (
        typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
      ) {
        httpStatus = status;

        break;
      }
    }

    if (httpStatus !== undefined) {
      break;
    }
  }

  const classes = chain.map(safeClass);
  const codes = chain.map((entry) => field(entry, 'code'));
  let classification: FailureClassification = 'unclassified';

  if (
    classes.some((name) => errorClasses[name] === 'timeout') ||
    codes.some((code) => typeof code === 'string' && timeoutCodes.has(code)) ||
    httpStatus === 408 ||
    httpStatus === 504 ||
    (signal?.aborted && safeClass(signal.reason) === 'TimeoutError')
  ) {
    classification = 'timeout';
  } else if (
    signal?.aborted ||
    classes.some((name) => errorClasses[name] === 'abort')
  ) {
    classification = 'abort';
  } else if (
    chain.some(
      (entry) =>
        safeClass(entry) === 'AI_NoObjectGeneratedError' &&
        field(entry, 'finishReason') === 'length',
    )
  ) {
    classification = 'outputlimit';
  } else if (classes.some((name) => errorClasses[name] === 'schema')) {
    classification = 'schema';
  } else if (
    httpStatus !== undefined ||
    classes.some((name) => errorClasses[name] === 'provider') ||
    codes.some((code) => typeof code === 'string' && networkCodes.has(code))
  ) {
    classification = 'provider';
  }

  return {
    classification,
    errorClass: safeClass(error),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
};
