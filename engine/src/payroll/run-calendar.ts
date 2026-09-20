import { PayrollError } from "./error.ts";
export type ScheduleRow = {
  id: string; frequency: string; periods_per_year: number;
  anchor_period_end: string; pay_date_offset_days: number;
};

export const DAY = 24 * 60 * 60 * 1000;
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const at = (s: string) => new Date(`${s}T00:00:00Z`);

/**
 * The two days of the month a semi-monthly schedule's periods end on.
 *
 * `month_end` is a boundary KIND, not a day number: the second half of a month
 * runs to whatever the month's last day is (31, 30, 29, 28), which no
 * day-of-month can express.
 */
export interface SemiMonthlyBoundaries {
  /** Day-of-month the FIRST period of each month ends on (1–15). */
  firstDay: number;
  /** Day-of-month the SECOND period ends on, or the month's last day. */
  secondDay: number | "month_end";
}



const monthLengthOf = (d: Date): number =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

/**
 * Why an anchor cannot name a semi-monthly schedule, or null if it can.
 *
 * The derivation rule (see `semiMonthlyBoundaries`) needs BOTH period-end days
 * to be unambiguous in every month of the year. Two anchor shapes are not, and
 * are refused by name at save time rather than quietly reinterpreted:
 *
 * - **the 14th** — its half-month complement is the 29th, which February does
 *   not always have, and "the 14th and the month end" is not a half-month
 *   split of anything. There is no second boundary to derive.
 * - **the last day of a 28-day February** — read as a day-of-month it means
 *   the 28th (a day every month has, complement the 13th); read as the month
 *   end it means the 15th-and-month-end schedule. Both readings are coherent
 *   and they are different calendars, so the anchor does not determine one.
 *   Anchoring on a 30- or 31-day month's last day says month end with no
 *   ambiguity at all.
 *
 * Everything else derives: 1–13 and 16–28 are fixed day pairs, and 15 / 29 /
 * 30 / 31 all mean "the 15th and the month end" (29, 30 and 31 are not days
 * every month has, so month end is their only coherent reading).
 */
export function semiMonthlyAnchorProblem(anchorPeriodEnd: string): string | null {
  const anchor = at(anchorPeriodEnd);
  if (Number.isNaN(anchor.getTime())) {
    return `"${anchorPeriodEnd}" is not a date, so no semi-monthly period can be derived from it`;
  }
  const day = anchor.getUTCDate();
  const monthLength = monthLengthOf(anchor);
  if (day === 28 && monthLength === 28) {
    return "a semi-monthly schedule anchored on the last day of February cannot be read: the 28th "
      + "is both a day every month has (periods would end on the 13th and the 28th) and February's "
      + "month end (periods would end on the 15th and the last day of the month), and those are "
      + "different calendars — anchor it on the last day of a 30- or 31-day month for the "
      + "15th-and-month-end schedule, or on the 28th of a longer month to mean the 28th";
  }
  if (day === 14) {
    return "a semi-monthly schedule anchored on the 14th has no second period end: half a month "
      + "later is the 29th, which February does not always have — anchor it on a day from 1 to 13 "
      + "or 16 to 28 (its complement is then the same day ±15), on the 15th, or on the last day of "
      + "a 30- or 31-day month (the 15th-and-month-end schedule)";
  }
  return null;
}

/**
 * Factor P must be a count the schedule's own boundaries can actually produce.
 *
 * `periods_per_year` is not decoration: the statutory engines annualize on it
 * (T4127 factor P, Pub 15-T's periods-per-year), so a semi-monthly calendar
 * saved with 26 pays 24 times a year while every withholding calculation
 * annualizes as though it paid 26 — wrong tax for everyone on the schedule,
 * every period, with nothing on screen to show it. The table's own CHECK only
 * constrains the value to the union of all frequencies' legal counts, which is
 * why the pairing has to be enforced here.
 *
 * 53 and 27 are the long-year counts (a year containing 53 Fridays, or 27
 * biweekly paydays) and are legal for exactly the frequencies that can have
 * them. Semi-monthly and monthly are defined by the calendar month, so they
 * admit no long year.
 */
const PERIODS_PER_YEAR_BY_FREQUENCY: Record<string, number[]> = {
  weekly: [52, 53],
  biweekly: [26, 27],
  semi_monthly: [24],
  monthly: [12],
};

export function payPeriodsPerYearProblem(
  frequency: string,
  periodsPerYear: number,
): string | null {
  const legal = PERIODS_PER_YEAR_BY_FREQUENCY[frequency];
  if (!legal) return null; // unknown frequency is the enum's refusal, not ours
  if (legal.includes(periodsPerYear)) return null;
  const allowed = legal.length === 1
    ? `${legal[0]}`
    : `${legal.slice(0, -1).join(", ")} or ${legal[legal.length - 1]}`;
  return `a ${frequency.replace(/_/g, "-")} schedule pays ${allowed} times a year, not `
    + `${periodsPerYear} — the periods per year is what every statutory calculation annualizes `
    + `with, so a count the schedule's own period boundaries cannot produce withholds the wrong `
    + `tax on every pay`;
}

/**
 * The period-end days a semi-monthly schedule uses, derived from its anchor —
 * the same way the monthly branch derives from its anchor's day-of-month.
 *
 * `anchor_period_end` is `notNull` on `pay_schedules`; discarding it for one
 * frequency is what let an employer paying the 5th and the 20th save without
 * error and then be paid on the 15th and the month end.
 */
export function semiMonthlyBoundaries(anchorPeriodEnd: string): SemiMonthlyBoundaries {
  const problem = semiMonthlyAnchorProblem(anchorPeriodEnd);
  if (problem) throw new PayrollError(problem);
  const day = at(anchorPeriodEnd).getUTCDate();
  // 29, 30 and 31 are not days every month has, so an anchor on one of them
  // can only mean the month end; the month end's half-month partner is the
  // 15th, because the halves of a month are the 1st–15th and the 16th–last.
  if (day === 15 || day >= 29) return { firstDay: 15, secondDay: "month_end" };
  return day < 15
    ? { firstDay: day, secondDay: day + 15 }
    : { firstDay: day - 15, secondDay: day };
}

/** The two period-end dates the boundaries produce in one calendar month. */
function semiMonthlyEndsIn(
  boundaries: SemiMonthlyBoundaries, year: number, month: number,
): [Date, Date] {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const second = boundaries.secondDay === "month_end" ? lastDay : boundaries.secondDay;
  return [new Date(Date.UTC(year, month, boundaries.firstDay)), new Date(Date.UTC(year, month, second))];
}

/** Period boundaries for a schedule: [start, end] containing/after `from`. */
export function nextPeriodAfter(
  schedule: Pick<ScheduleRow, "frequency" | "anchor_period_end">,
  lastPeriodEnd: string | null,
): { periodStart: string; periodEnd: string } {
  const anchor = at(schedule.anchor_period_end);
  if (schedule.frequency === "weekly" || schedule.frequency === "biweekly") {
    const span = schedule.frequency === "weekly" ? 7 : 14;
    let end = anchor;
    if (lastPeriodEnd) {
      const last = at(lastPeriodEnd);
      const steps = Math.max(1, Math.ceil((last.getTime() - anchor.getTime()) / (span * DAY) + 1));
      end = new Date(anchor.getTime() + steps * span * DAY);
      while (end.getTime() <= last.getTime()) end = new Date(end.getTime() + span * DAY);
    }
    return { periodStart: iso(new Date(end.getTime() - (span - 1) * DAY)), periodEnd: iso(end) };
  }
  if (schedule.frequency === "semi_monthly") {
    // The anchor's own day-of-month is one of the two boundaries, and its
    // half-month complement is the other — so an anchor of 2026-01-20 pays the
    // 6th–20th and the 21st–5th, not 1–15 / 16–EOM.
    const boundaries = semiMonthlyBoundaries(schedule.anchor_period_end);
    const cursor = lastPeriodEnd ? at(lastPeriodEnd) : new Date(anchor.getTime() - DAY);
    // Starting a month BEFORE the cursor's month guarantees the preceding
    // boundary is known before the first candidate is accepted, so the period
    // START is always the day after the previous period ended — including
    // across a month boundary, where it lives in the previous month.
    // Seeded from the month before the cursor's, both of whose boundaries are
    // necessarily on or before the cursor.
    const seed = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
    let previous = semiMonthlyEndsIn(boundaries, seed.getUTCFullYear(), seed.getUTCMonth())[1];
    for (let m = 0; m < 26; m++) {
      const base = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + m, 1));
      for (const end of semiMonthlyEndsIn(boundaries, base.getUTCFullYear(), base.getUTCMonth())) {
        if (end.getTime() > cursor.getTime()) {
          return { periodStart: iso(new Date(previous.getTime() + DAY)), periodEnd: iso(end) };
        }
        previous = end;
      }
    }
    throw new PayrollError("could not derive the next semi-monthly period");
  }
  // monthly: end on the anchor's day-of-month, clamped to month end.
  const anchorDay = anchor.getUTCDate();
  const cursor = lastPeriodEnd ? at(lastPeriodEnd) : new Date(anchor.getTime() - DAY);
  for (let m = 0; m < 14; m++) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth() + m;
    const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const end = new Date(Date.UTC(y, mo, Math.min(anchorDay, lastDay)));
    if (end.getTime() > cursor.getTime()) {
      const prevLast = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const start = new Date(Date.UTC(y, mo - 1, Math.min(anchorDay, prevLast) + 1));
      return { periodStart: iso(start), periodEnd: iso(end) };
    }
  }
  throw new PayrollError("could not derive the next monthly period");
}
