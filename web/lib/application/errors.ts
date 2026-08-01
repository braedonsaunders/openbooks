export type ApplicationErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unsupported_operation"
  | "rate_limited"
  | "internal_error";

/** Safe, transport-neutral error produced by the application layer. */
export class ApplicationError extends Error {
  readonly name = "ApplicationError";

  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function invalidInput(
  message: string,
  details?: Record<string, unknown>,
): ApplicationError {
  return new ApplicationError("invalid_input", message, 422, details);
}

export function forbidden(permission: string): ApplicationError {
  return new ApplicationError("forbidden", "forbidden", 403, { permission });
}

export function notFound(resource = "record"): ApplicationError {
  return new ApplicationError("not_found", `${resource} not found`, 404);
}

export function conflict(
  message: string,
  details?: Record<string, unknown>,
): ApplicationError {
  return new ApplicationError("conflict", message, 409, details);
}
