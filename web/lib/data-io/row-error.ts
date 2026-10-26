import { randomUUID } from "node:crypto";
import { pgErrorCode } from "../setup/coerce";

/** Database wrappers contain SQL and bound values; retain them only in the log. */
export function importRowError(
  error: unknown,
  fallback = "The record could not be saved — check its values and retry.",
): string {
  // A typed domain refusal (an Error subclass carrying a 4xx status) names its
  // remedy in its message; its own machine code is not a database code.
  if (error instanceof Error && error.constructor !== Error) {
    const status = (error as Error & { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500)
      return error.message;
  }
  // Explicit database RAISE refusals are operator instructions, unlike driver
  // failures. Unwrap the cause so the SQL wrapper never becomes the message.
  let cause: unknown = error;
  while (cause && typeof cause === "object" && "cause" in cause && cause.cause) cause = cause.cause;
  const code = pgErrorCode(error);
  const raised =
    cause && typeof cause === "object" && "routine" in cause && cause.routine === "exec_stmt_raise";
  if (code === "P0001" || (code === "23514" && raised)) {
    if (cause instanceof Error) return cause.message;
    if (
      cause &&
      typeof cause === "object" &&
      "message" in cause &&
      typeof cause.message === "string"
    )
      return cause.message;
  }
  if (code) {
    const reference = randomUUID();
    console.error(`[data-import] storage refusal (${reference}):`, error);
    return `The record could not be saved. Ask an administrator to inspect log reference ${reference}, correct the cause, then retry.`;
  }
  return error instanceof Error ? error.message : fallback;
}
