import { canonicalNonNegativeDecimal, fixedDecimal, isPositiveDecimal } from "../money/exact-decimal.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { isPayRateBasis } from "../projects/pay-rate-basis.ts";
import type { PayrollWageRounding } from "../projects/payroll-wage-rounding.ts";
import { PayrollError } from "./error.ts";
import { payrollHourlyWage, type PayableRate } from "./rate.ts";
import { priceDatedWageEntries } from "./wage-rounding.ts";

/** An evidenced unpaid entitlement, separate from ordinary worked time.
 * Approval, employment scope and prior-payment checks belong to its writer.
 * The instruction carries paid hours; payroll resolves its dated wage. */
export interface AdjudicatedHolidayPayment {
  readonly employeePartyId: string;
  readonly holidayDates: readonly string[];
  readonly hours: string;
  readonly assessedOn: string;
  readonly wageBasisDate: string;
  readonly paymentDate: string;
  readonly instructionKey: string;
  readonly sourceReference: string;
  readonly sourceDigest: string;
}

const FIELDS = new Set([
  "employeePartyId", "holidayDates", "hours", "assessedOn", "wageBasisDate",
  "paymentDate", "instructionKey", "sourceReference", "sourceDigest",
]);

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new PayrollError(`${field} must contain 1 to ${maximum} characters of source evidence.`);
  }
  return value.trim();
}

function requiredDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !isIsoCalendarDate(value)) {
    throw new PayrollError(`${field} must be a valid calendar date in YYYY-MM-DD form.`);
  }
  return value;
}

/** Refuse cash overrides and incomplete evidence before any financial write. */
export function readAdjudicatedHolidayPayment(value: unknown): AdjudicatedHolidayPayment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PayrollError("Provide an evidenced holiday-payment instruction.");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!FIELDS.has(key)) throw new PayrollError(`Holiday-payment field ${key} is not supported; supply paid hours and source evidence, not a calculated cash amount.`);
  }
  if (typeof input.employeePartyId !== "string" || !isUuid(input.employeePartyId)) {
    throw new PayrollError("Select the employee named in the holiday-payment evidence.");
  }
  const paymentDate = requiredDate(input.paymentDate, "paymentDate");
  const assessedOn = requiredDate(input.assessedOn, "assessedOn");
  const wageBasisDate = requiredDate(input.wageBasisDate, "wageBasisDate");
  if (assessedOn > paymentDate || wageBasisDate > paymentDate) {
    throw new PayrollError("The entitlement assessment and wage basis must not be later than the instructed payment date.");
  }
  if (!Array.isArray(input.holidayDates) || input.holidayDates.length < 1) {
    throw new PayrollError("Identify every holiday covered by the unpaid entitlement.");
  }
  const holidayDates = input.holidayDates.map(date => requiredDate(date, "holidayDates"));
  if (new Set(holidayDates).size !== holidayDates.length) {
    throw new PayrollError("A holiday occurrence can appear only once in a payment instruction.");
  }
  if (holidayDates.some(date => date > assessedOn || date >= paymentDate)) {
    throw new PayrollError("Deferred holiday pay must identify holidays already assessed before their instructed payment date.");
  }
  const hours = canonicalNonNegativeDecimal(input.hours, 2);
  if (hours === null || !isPositiveDecimal(hours) || hours.split(".")[0]!.length > 10) {
    throw new PayrollError("Unpaid holiday hours must be a positive exact decimal with at most 2 decimal places and 10 whole digits.");
  }
  const sourceDigest = requiredText(input.sourceDigest, "sourceDigest", 64);
  if (!/^[a-f0-9]{64}$/i.test(sourceDigest)) {
    throw new PayrollError("Provide the SHA-256 digest of the retained holiday-payment source.");
  }
  return {
    employeePartyId: input.employeePartyId.toLowerCase(),
    holidayDates: [...holidayDates].sort(),
    hours: fixedDecimal(hours, 2),
    assessedOn, wageBasisDate, paymentDate,
    instructionKey: requiredText(input.instructionKey, "instructionKey", 200),
    sourceReference: requiredText(input.sourceReference, "sourceReference", 2000),
    sourceDigest: sourceDigest.toLowerCase(),
  };
}

/** Use the same dated wage and rounding terms as periodic payroll.
 * The hours are paid entitlement units, never timesheet entries. */
export function priceAdjudicatedHolidayPayment(
  instruction: AdjudicatedHolidayPayment,
  effectiveRate: PayableRate & PayrollWageRounding,
): { hours: string; rate: string; amount: string } {
  const reviewed = readAdjudicatedHolidayPayment(instruction);
  const rate = canonicalNonNegativeDecimal(effectiveRate.rate, 4);
  const annualHours = canonicalNonNegativeDecimal(effectiveRate.annualHours, 4);
  const basis = effectiveRate.basis;
  if (!isPayRateBasis(basis)) throw new PayrollError("Resolve a wage quoted in a supported native pay cadence before pricing the holiday entitlement.");
  if (rate === null || !isPositiveDecimal(rate) || basis !== "hour" && (annualHours === null || !isPositiveDecimal(annualHours))) {
    throw new PayrollError("Resolve a positive dated wage and annual-hours basis before pricing the holiday entitlement.");
  }
  const priced = priceDatedWageEntries(payrollHourlyWage({ rate, basis, annualHours: effectiveRate.annualHours }), "1", [
    { workedOn: reviewed.wageBasisDate, hours: reviewed.hours },
  ], effectiveRate);
  if (priced.days.length !== 1) throw new PayrollError("The holiday payment did not resolve to one dated wage calculation.");
  if (!isPositiveDecimal(priced.rate) || priced.rate.split(".")[0]!.length > 15) {
    throw new PayrollError("The dated holiday wage does not resolve to a positive rate within the payroll rate column; review its wage and declared rate precision.");
  }
  if (priced.days[0]!.amount.split(".")[0]!.length > 15) {
    throw new PayrollError("The holiday entitlement exceeds the payroll amount column; review its source hours and dated wage.");
  }
  return { hours: reviewed.hours, rate: priced.rate, amount: priced.days[0]!.amount };
}
