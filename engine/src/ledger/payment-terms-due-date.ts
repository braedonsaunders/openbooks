import { addCalendarDays, addMonthsStart, civilDateFromParts, daysInCivilMonth, isIsoCalendarDate } from "../platform/civil-date.ts";

/**
 * The one due-date rule for payment terms. Every surface that derives a due
 * date from terms (document defaults, posting, recurring billing) calls
 * `paymentTermsDueDate`; Setup and connector imports validate through
 * `paymentTermsDueRuleRefusal` so stored terms are always computable.
 *
 * Standard terms are due `netDays` calendar days after the document date
 * ("Due on receipt" is 0, "Net 30" is 30).
 *
 * Day-of-month terms (`dueDayOfMonth` set) are due on that day of a month:
 * the first such day falling more than `netDays` days after the document
 * date. `netDays` is the minimum time to pay, so a document dated within
 * that many days of a month's due day moves to the next month's. A due day
 * past the end of a short month falls on that month's last day, so 31 means
 * month end. Examples with a due day of 1: Net 0 dated 22 October is due
 * 1 November; Net 30 dated 22 October is due 1 December.
 */
export interface PaymentTermsDueRule {
  netDays: number;
  dueDayOfMonth: number | null;
}

export const PAYMENT_TERMS_MAX_NET_DAYS = 3_652_058;
export const PAYMENT_TERMS_DUE_DAY_MIN = 1;
export const PAYMENT_TERMS_DUE_DAY_MAX = 31;

export class PaymentTermsDueDateError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "PaymentTermsDueDateError";
  }
}

/** Why a rule cannot be stored or applied, or null when it is valid. */
export function paymentTermsDueRuleRefusal(rule: { netDays: unknown; dueDayOfMonth: unknown }): string | null {
  const { netDays, dueDayOfMonth } = rule;
  if (typeof netDays !== "number" || !Number.isSafeInteger(netDays) || netDays < 0 || netDays > PAYMENT_TERMS_MAX_NET_DAYS) {
    return `Payment terms must state zero or more whole net days; found ${String(netDays)}. Correct the terms in Setup → Payment terms`;
  }
  if (dueDayOfMonth !== null && (typeof dueDayOfMonth !== "number" || !Number.isSafeInteger(dueDayOfMonth)
    || dueDayOfMonth < PAYMENT_TERMS_DUE_DAY_MIN || dueDayOfMonth > PAYMENT_TERMS_DUE_DAY_MAX)) {
    return `Payment terms due day of month must be a whole day from ${PAYMENT_TERMS_DUE_DAY_MIN} to ${PAYMENT_TERMS_DUE_DAY_MAX}, or blank for terms counted only in days; found ${String(dueDayOfMonth)}. Correct the terms in Setup → Payment terms`;
  }
  return null;
}

/** The due day within the calendar month containing `date`, clamped to month end. */
function dueDayIn(date: string, dueDayOfMonth: number): string {
  const year = Number(date.slice(0, 4));
  const month1 = Number(date.slice(5, 7));
  return civilDateFromParts(year, month1, Math.min(dueDayOfMonth, daysInCivilMonth(year, month1)));
}

/** The due date of a document dated `documentDate` under `rule`. */
export function paymentTermsDueDate(documentDate: string, rule: PaymentTermsDueRule): string {
  if (!isIsoCalendarDate(documentDate)) throw new PaymentTermsDueDateError("document date must be a calendar date (YYYY-MM-DD)");
  const refusal = paymentTermsDueRuleRefusal(rule);
  if (refusal) throw new PaymentTermsDueDateError(refusal);
  try {
    const earliest = addCalendarDays(documentDate, rule.netDays);
    if (rule.dueDayOfMonth === null) return earliest;
    const sameMonth = dueDayIn(earliest, rule.dueDayOfMonth);
    return sameMonth > earliest ? sameMonth : dueDayIn(addMonthsStart(earliest, 1), rule.dueDayOfMonth);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new PaymentTermsDueDateError(`The payment terms put the due date for a document dated ${documentDate} past the supported calendar (year 9999)`);
    }
    throw error;
  }
}
