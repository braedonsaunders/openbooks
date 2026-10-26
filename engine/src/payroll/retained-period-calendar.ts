import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { at, DAY, iso, nextPeriodAfter } from "./run-calendar.ts";

/** Retained dates must describe a complete native cadence without borrowing today's schedule anchor. */
export function retainedPayPeriodProblem(
  frequency: string,
  periodStart: string,
  periodEnd: string,
): string | null {
  if (!isIsoCalendarDate(periodStart) || !isIsoCalendarDate(periodEnd) || periodStart > periodEnd)
    return "Retained reporting periods need valid ordered calendar dates";
  const days = (at(periodEnd).getTime() - at(periodStart).getTime()) / DAY + 1;
  if (frequency === "weekly" || frequency === "biweekly")
    return days === (frequency === "weekly" ? 7 : 14)
      ? null
      : "Retained reporting periods do not match the declared pay-period type";
  if (frequency !== "monthly" && frequency !== "semi_monthly")
    return "Unsupported retained reporting frequency";
  const previousEnd = iso(new Date(at(periodStart).getTime() - DAY));
  // Enumerate the native boundary kinds, not an employee's current mutable anchor.
  // January has all possible monthly anchor days and unambiguous half-month pairs.
  const anchorDays =
    frequency === "monthly"
      ? Array.from({ length: 31 }, (_, i) => i + 1)
      : [...Array.from({ length: 13 }, (_, i) => i + 1), 15];
  for (const day of anchorDays) {
    const expected = nextPeriodAfter(
      { frequency, anchor_period_end: `2000-01-${String(day).padStart(2, "0")}` },
      previousEnd,
    );
    if (expected.periodStart === periodStart && expected.periodEnd === periodEnd) return null;
  }
  return "Retained reporting dates must cover one complete calendar-based pay period — qualify the original period boundaries before filing";
}
