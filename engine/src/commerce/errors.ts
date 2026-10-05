/**
 * Shared commerce refusal. One base for every computed commerce refusal: a
 * snake_case code, the message the operator reads, the remedy that fixes it,
 * and the field to correct (null when no single field is at fault). The HTTP
 * layer maps `status` — 422 for a refused request, 409 for a write colliding
 * with a committed row — and the route factory renders code, message, remedy
 * and field together, so a refusal always arrives with its fix attached.
 *
 * This module imports nothing, so the adapter contract and the database
 * services share one refusal identity without importing each other.
 */
/** A stable snake_case refusal code; each service names its own and never reuses one. */
export type CommerceCode = string;

/**
 * Read the Postgres code/constraint through the driver's query-error wrapper:
 * `db.execute` throws the driver's error wrapped once, so matching `code`
 * on the outer object never fires and a computed refusal would be lost.
 */
export function pgCause(error: unknown): { code?: unknown; constraint?: unknown } {
  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") return cause as { code?: unknown; constraint?: unknown };
  }
  return error as { code?: unknown; constraint?: unknown };
}

export class CommerceError extends Error {
  readonly code: CommerceCode;
  readonly remedy: string;
  readonly field: string | null;
  readonly status: 422 | 409;

  constructor(
    code: CommerceCode,
    message: string,
    remedy: string,
    options?: { field?: string | null; status?: 422 | 409 },
  ) {
    super(message);
    this.name = "CommerceError";
    this.code = code;
    this.remedy = remedy;
    this.field = options?.field ?? null;
    this.status = options?.status ?? 422;
  }
}
