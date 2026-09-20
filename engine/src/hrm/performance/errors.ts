/**
 * Governed HRM performance refusal (0196, HR-7). New refusal class — the
 * brief forbids touching existing refusal classes, and a shared message
 * contract needs its own code vocabulary.
 */
import { PerformanceMathError } from "./performance-math.ts";

export type HrmPerformanceCode =
  | "NOT_FOUND"
  | "BAD_STATE"
  | "REFUSED"
  | "FORBIDDEN"
  | "TEMPLATE_NOT_FOUND"
  | "NO_REQUIRED_QUESTION"
  | "DUPLICATE"
  | "STALE_REVISION"
  | "FEATURE_OFF"
  | "INVALID_INPUT";

export class HrmPerformanceError extends Error {
  readonly code: HrmPerformanceCode;
  constructor(code: HrmPerformanceCode, message: string) {
    super(message);
    this.name = "HrmPerformanceError";
    this.code = code;
  }
}

/**
 * The pure-math module throws PerformanceMathError; every service boundary
 * maps it to HrmPerformanceError with the message intact. A computed
 * refusal must reach the caller as the governed class — the route error
 * mapping, the assistant hrmRefusal, and the tests only know this class,
 * so a raw math error escaping would surface as an unmapped 500 instead
 * of the named refusal.
 */
export function mathRefusal<T>(code: HrmPerformanceCode, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PerformanceMathError) {
      throw new HrmPerformanceError(code, e.message);
    }
    throw e;
  }
}

/**
 * True when the error is PostgreSQL unique violation 23505 on the named
 * constraint, walking the driver cause chain: the constraint name lives
 * on the pg error's `constraint` field (and in its detail), never in the
 * driver's top-level message, so matching the message alone drops the
 * refusal and leaks a driver error to the caller.
 */
export function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  const seen = new Set<unknown>();
  for (let cur: unknown = error; cur !== null && typeof cur === "object"; ) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    const record = cur as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (record.code === "23505" && record.constraint === constraint) return true;
    if (typeof record.message === "string" && record.message.includes(constraint)) return true;
    cur = record.cause;
  }
  return false;
}
