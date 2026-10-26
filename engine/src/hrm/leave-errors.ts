/**
 * Shared leave refusal. Lives in its own module so the write service
 * (leave.ts) and the read service (leave-read.ts) share one refusal shape
 * without a module cycle.
 *
 * Every refusal names the remedy, and the remedy exists — check the code it
 * points at before writing a new one.
 */
export type LeaveErrorCode =
  "INVALID_INPUT" | "NOT_FOUND" | "BAD_STATE" | "STALE_RUN" | "NO_FLOW" | "FLOW_ERROR" | "REFUSED";

export class LeaveError extends Error {
  readonly code: LeaveErrorCode;
  constructor(code: LeaveErrorCode, message: string) {
    super(message);
    this.name = "LeaveError";
    this.code = code;
  }
}

/** Read a PostgreSQL SQLSTATE through any driver or transaction wrappers. */
export function postgresErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  for (let current: unknown = error; current !== null && typeof current === "object";) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}
