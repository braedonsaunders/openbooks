/** Date/decimal input helpers for recognition math. Split from revenue/recognition.ts (pure moves only). */
import { MAX_RECOGNITION_DAY_OFFSET, MIN_RECOGNITION_DAY_OFFSET } from "./recognition-limits.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { RevenueRecognitionError } from "./recognition-transaction-price.ts";
import { addCalendarDays } from "../platform/civil-date.ts";

// ---------------------------------------------------------------------------
// Date helpers (UTC, no wall-clock dependency)
// ---------------------------------------------------------------------------

export function recognitionDate(value: string, label = "recognition date"): Date {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : new Date(NaN);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || value.startsWith("0000-") || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RevenueRecognitionError(`${label} must be a valid ISO calendar date`);
  }
  return date;
}

export function recognitionInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_RECOGNITION_DAY_OFFSET) {
    throw new RevenueRecognitionError(`${label} must be a whole number from ${minimum} through ${MAX_RECOGNITION_DAY_OFFSET}`);
  }
  return value;
}

export function recognitionEventDecimal(value: string, label: string): string {
  const decimal = typeof value === "string" ? canonicalDecimal(value, 4) : null;
  if (decimal === null || decimal.replace(/^-/, "").split(".")[0]!.length > 15) {
    throw new RevenueRecognitionError(`${label} must be an exact decimal within numeric(19,4) precision`);
  }
  return decimal;
}

export function eventMonth(value: string): void {
  recognitionDate(value, "event month");
  if (!value.endsWith("-01")) throw new RevenueRecognitionError("event month must be the first day of a calendar month");
}

/**
 * Run platform civil-date arithmetic, refusing a date beyond the supported
 * calendar (0001 through 9999) as a recognition error instead of letting the
 * platform's RangeError surface as an unexplained failure.
 */
export function onRecognitionCalendar<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof RangeError) throw new RevenueRecognitionError("recognition date exceeds the supported calendar");
    throw error;
  }
}

/** Shift a recognition date by a whole-day offset within the recognition bounds. */
export function shiftRecognitionDate(date: string, days: number): string {
  recognitionDate(date);
  recognitionInteger(days, "day offset", MIN_RECOGNITION_DAY_OFFSET);
  return onRecognitionCalendar(() => addCalendarDays(date, days));
}
