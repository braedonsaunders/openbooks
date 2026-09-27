/**
 * Shared usage-billing refusal. One base for every computed usage refusal: a
 * snake_case code, the message the operator reads, the remedy that fixes it,
 * and the field to correct (null when no single field is at fault). The HTTP
 * layer maps `status` — 422 for a refused request, 409 for a re-rate
 * colliding with a committed run — and the route factory renders code,
 * message, remedy and field together, so a refusal always arrives with its
 * fix attached.
 *
 * This module imports nothing, so the pure rating kernel and the database
 * services share one refusal identity without importing each other.
 */
/** A stable snake_case refusal code; each service names its own and never reuses one. */
export type UsageBillingCode = string;

export class UsageBillingError extends Error {
  readonly code: UsageBillingCode;
  readonly remedy: string;
  readonly field: string | null;
  readonly status: 422 | 409;

  constructor(
    code: UsageBillingCode,
    message: string,
    remedy: string,
    options?: { field?: string | null; status?: 422 | 409 },
  ) {
    super(message);
    this.name = "UsageBillingError";
    this.code = code;
    this.remedy = remedy;
    this.field = options?.field ?? null;
    this.status = options?.status ?? 422;
  }
}
