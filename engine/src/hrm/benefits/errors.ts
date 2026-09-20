/**
 * Shared benefits refusal. Lives in its own module so the write services
 * (plans/windows/enrollments/dependents/benefits-payroll) and the read
 * service (benefits-read) share one refusal shape without a module cycle.
 *
 * Every refusal names the remedy, and the remedy exists — check the code it
 * points at before writing a new one.
 */
export type BenefitsErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "BAD_STATE" | "REFUSED";

export class BenefitsError extends Error {
  readonly code: BenefitsErrorCode;
  constructor(code: BenefitsErrorCode, message: string) {
    super(message);
    this.name = "BenefitsError";
    this.code = code;
  }
}
