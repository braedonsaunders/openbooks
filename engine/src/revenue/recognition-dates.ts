/** Date/decimal input helpers for recognition math. Split from revenue/recognition.ts (pure moves only). */
import { MAX_RECOGNITION_DAY_OFFSET, MIN_RECOGNITION_DAY_OFFSET } from "./recognition-limits.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { RevenueRecognitionError } from "./recognition-transaction-price.ts";

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

/** First day of the month for a YYYY-MM-DD date, as YYYY-MM-01. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Add n months to a YYYY-MM-01 string, returning YYYY-MM-01. */
export function addMonths(monthStartDate: string, n: number): string {
  const [y, m] = monthStartDate.split("-").map(Number);
  const total = y! * 12 + (m! - 1) + n;
  const ny = Math.floor(total / 12);
  if (ny < 1 || ny > 9999) throw new RevenueRecognitionError("recognition date exceeds the supported calendar");
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/** Days in the calendar month containing a YYYY-MM-DD date. */
export function daysInMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  const end = new Date(0);
  end.setUTCFullYear(y!, m!, 0);
  return end.getUTCDate();
}

/** Last day of the month for a YYYY-MM-DD date, as YYYY-MM-DD. */
export function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(daysInMonth(date)).padStart(2, "0")}`;
}

/** Parse YYYY-MM-DD to a UTC epoch-day integer. */
export function epochDay(date: string): number {
  return Math.floor(recognitionDate(date).getTime() / 86_400_000);
}

/** Inclusive day count between two YYYY-MM-DD dates (end − start + 1). */
export function inclusiveDays(startOn: string, endOn: string): number {
  return epochDay(endOn) - epochDay(startOn) + 1;
}

/** Shift a YYYY-MM-DD date by n days, returning YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  recognitionInteger(n, "day offset", MIN_RECOGNITION_DAY_OFFSET);
  const dt = new Date((epochDay(date) + n) * 86_400_000);
  if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() < 1 || dt.getUTCFullYear() > 9999) {
    throw new RevenueRecognitionError("recognition date exceeds the supported calendar");
  }
  return dt.toISOString().slice(0, 10);
}
