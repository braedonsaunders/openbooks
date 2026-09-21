/**
 * Compensation errors (HR-12, 0221/0222).
 *
 * A computed refusal must reach the caller with its message intact — the
 * remedy lives in the message — and a code that names the failure shape.
 * REFUSED = the rule fired (caller can act on the remedy); NOT_FOUND =
 * the subject is not visible in this org; BAD_STATE = the lifecycle does
 * not allow this transition; STALE_REVISION = the row moved under us;
 * INVALID_INPUT = the body itself is malformed.
 */
export class CompensationError extends Error {
  readonly code: "REFUSED" | "NOT_FOUND" | "BAD_STATE" | "STALE_REVISION" | "INVALID_INPUT";
  constructor(
    code: "REFUSED" | "NOT_FOUND" | "BAD_STATE" | "STALE_REVISION" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "CompensationError";
    this.code = code;
  }
}

/** Wrap a pure-math throw into a REFUSED with the remedy attached. */
export function mathRefusal(message: string): CompensationError {
  return new CompensationError("REFUSED", message);
}
