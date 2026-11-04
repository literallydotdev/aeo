export const errorStatus = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  release_changed: 409,
  pipeline_active: 409,
  report_exists: 409,
  gate_not_waiting: 409,
  over_cost_cap: 429,
  service_unavailable: 503,
  incompatible_report: 503,
  internal: 500,
} as const;

export type ApiErrorCode = keyof typeof errorStatus;

type ApiErrorOptions = {
  details?: unknown;
};

/**
 * ApiError carries a client-facing code and message; its message is sent to
 * the caller as it is.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(
    code: ApiErrorCode,
    message: string,
    { details }: ApiErrorOptions = {},
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'ApiError';
  }
}

export const requireScope = (
  scopes: readonly string[],
  scope: string,
): void => {
  if (!scopes.includes(scope)) {
    throw new ApiError('forbidden', `Scope ${scope} is required`);
  }
};
