/** HR-20 shared error: every refusal names the remedy. */
export class FieldTimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FieldTimeError";
    this.code = code;
  }
}

/** Small helper: throw a named refusal. */
export function refuse(code: string, message: string): never {
  throw new FieldTimeError(code, message);
}

/**
 * True when the error is PostgreSQL foreign-key violation 23503,
 * walking the driver cause chain: the code lives on the pg error's
 * `code` field, never in the driver's top-level message, so matching
 * the message alone drops the fallback and leaks a driver error.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let cur: unknown = error; cur !== null && typeof cur === "object";) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    const record = cur as { code?: unknown; cause?: unknown };
    if (record.code === "23503") return true;
    cur = record.cause;
  }
  return false;
}

/**
 * True when the error is PostgreSQL unique violation 23505, walking the
 * driver cause chain like isForeignKeyViolation: a double-submit retry
 * surfaces as a wrapped driver error, never a bare pg error.
 */
export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let cur: unknown = error; cur !== null && typeof cur === "object";) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    const record = cur as { code?: unknown; cause?: unknown };
    if (record.code === "23505") return true;
    cur = record.cause;
  }
  return false;
}
