/**
 * Convertible note interest: day-count conventions and accrual.
 *
 * A note states its annual rate, how interest builds (simple, or compounded
 * every 12, 6, 3 or 1 months from the issue date) and how a part period is
 * counted:
 *  - actual_365: actual days / 365;
 *  - actual_360: actual days / 360;
 *  - thirty_360: the 30/360 US bond basis (a 31st counts as the 30th, and a
 *    closing 31st counts as the 30th when the period opened on the 30th or
 *    31st) / 360;
 *  - actual_actual: the ISDA basis, each calendar year's days over that
 *    year's length (365 or 366).
 * Simple interest is principal × rate × the year fraction from the issue
 * date. Compound interest grows the balance by rate × months / 12 at every
 * completed compounding period, the compounded balance rounded half up to
 * ten decimal places at each period so the arithmetic stays bounded, and
 * accrues the part period since the last one on the day count. Callers round
 * the result once, to the currency's minor unit, at the scale the ledger
 * stores.
 */
import { addMonthsClamped, calendarDaysBetween } from "../platform/civil-date.ts";
import { equityError } from "./errors.ts";
import {
  addRational,
  multiplyRational,
  ONE,
  parseMoney,
  parsePercent,
  PRICE_SCALE,
  quantize,
  rational,
  subtractRational,
  ZERO,
  type Rational,
} from "./quantities.ts";
import type { DayCount, InterestBasis } from "./types.ts";
import { completedMonths } from "./vesting.ts";

/** Months in one compounding period of a compound basis (null: simple interest). */
export const COMPOUNDING_MONTHS: Readonly<Record<InterestBasis, number | null>> = {
  simple: null,
  compound_annual: 12,
  compound_semiannual: 6,
  compound_quarterly: 3,
  compound_monthly: 1,
};

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function parts(iso: string): { y: number; m: number; d: number } {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

/** Days from `from` to `to` on the 30/360 US bond basis. */
export function days360(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  const d1 = Math.min(a.d, 30);
  const d2 = b.d === 31 && d1 === 30 ? 30 : b.d;
  return 360 * (b.y - a.y) + 30 * (b.m - a.m) + (d2 - d1);
}

/** The year fraction from `from` to `to` (zero when `to` is not after `from`). */
export function yearFraction(dayCount: DayCount, from: string, to: string): Rational {
  if (to <= from) return ZERO;
  switch (dayCount) {
    case "actual_365":
      return rational(BigInt(calendarDaysBetween(from, to)), 365n);
    case "actual_360":
      return rational(BigInt(calendarDaysBetween(from, to)), 360n);
    case "thirty_360":
      return rational(BigInt(days360(from, to)), 360n);
    case "actual_actual": {
      let total = ZERO;
      let cursor = from;
      while (cursor < to) {
        const year = Number(cursor.slice(0, 4));
        const nextYear = `${String(year + 1).padStart(4, "0")}-01-01`;
        const end = nextYear < to ? nextYear : to;
        total = addRational(
          total,
          rational(BigInt(calendarDaysBetween(cursor, end)), isLeap(year) ? 366n : 365n),
        );
        cursor = end;
      }
      return total;
    }
    default:
      throw equityError("noteDayCountMissing");
  }
}

export interface InterestTerms {
  issueDate: string;
  principal: string;
  interestRatePercent: string | null;
  interestBasis: InterestBasis | null;
  interestDayCount: DayCount | null;
}

/** Interest accrued from the issue date to `asOf` (exact, in the note's currency). */
export function noteInterest(terms: InterestTerms, asOf: string): Rational {
  if (asOf <= terms.issueDate) return ZERO;
  const principal = parseMoney(terms.principal, "principal");
  const rate = parsePercent(terms.interestRatePercent ?? "", "interestRatePercent");
  if (!terms.interestBasis || !(terms.interestBasis in COMPOUNDING_MONTHS)) {
    throw equityError("noteInterestBasisMissing");
  }
  const dayCount = terms.interestDayCount as DayCount;
  const months = COMPOUNDING_MONTHS[terms.interestBasis];
  if (months === null)
    return multiplyRational(
      principal,
      multiplyRational(rate, yearFraction(dayCount, terms.issueDate, asOf)),
    );
  const periods = Math.floor(completedMonths(terms.issueDate, asOf) / months);
  const last = addMonthsClamped(terms.issueDate, periods * months);
  const growth = addRational(ONE, multiplyRational(rate, rational(BigInt(months), 12n)));
  let value = principal;
  const scale = 10n ** BigInt(PRICE_SCALE);
  for (let period = 0; period < periods; period += 1)
    value = rational(quantize(multiplyRational(value, growth), PRICE_SCALE, "half_up"), scale);
  value = multiplyRational(
    value,
    addRational(ONE, multiplyRational(rate, yearFraction(dayCount, last, asOf))),
  );
  return subtractRational(value, principal);
}
