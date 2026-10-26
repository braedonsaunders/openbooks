import { add, cmp } from "../money/money.ts";
import { refuse } from "./asset-refusal.ts";
import { utcDateFromParts, calendarDaysBetween } from "../platform/civil-date.ts";

/**
 * Pure maintenance scheduling. A schedule recurs every N months, every N
 * meter units, or both (whichever comes first). The next due point counts
 * from the last time the work was performed, or from the schedule's start
 * date and a zero meter when it never has been.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(value: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(value);
  if (!match) refuse("date_invalid", `${value} is not a calendar date (YYYY-MM-DD)`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = utcDateFromParts(year, month - 1, day);
  if (
    year < 1 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    refuse("date_invalid", `${value} is not a calendar date (YYYY-MM-DD)`);
  }
  return { year, month, day };
}

function formatIsoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Add calendar months, clamping to the last day of a shorter month (Jan 31 + 1 → Feb 28/29). */
export function addMonthsClamped(date: string, months: number): string {
  if (!Number.isInteger(months))
    refuse("interval_invalid", "the month interval must be a whole number");
  const { year, month, day } = parseIsoDate(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const lastDay = utcDateFromParts(targetYear, targetMonth, 0).getUTCDate();
  return formatIsoDate(targetYear, targetMonth, Math.min(day, lastDay));
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  return calendarDaysBetween(
    formatIsoDate(a.year, a.month, a.day),
    formatIsoDate(b.year, b.month, b.day),
  );
}

export interface MaintenanceInterval {
  intervalMonths: number | null;
  intervalUsage: string | null;
  startsOn: string;
  lastPerformedOn: string | null;
  lastPerformedUsage: string | null;
}

export function assertMaintenanceInterval(
  interval: Pick<MaintenanceInterval, "intervalMonths" | "intervalUsage">,
): void {
  if (interval.intervalMonths === null && interval.intervalUsage === null) {
    refuse("interval_required", "set a time interval, a usage interval, or both");
  }
  if (
    interval.intervalMonths !== null &&
    (!Number.isInteger(interval.intervalMonths) ||
      interval.intervalMonths < 1 ||
      interval.intervalMonths > 600)
  ) {
    refuse("interval_invalid", "the month interval must be a whole number from 1 to 600");
  }
  if (interval.intervalUsage !== null && cmp(interval.intervalUsage, "0") <= 0) {
    refuse("interval_invalid", "the usage interval must be greater than zero");
  }
}

/** The next due date and meter value for a schedule. */
export function nextMaintenanceDue(interval: MaintenanceInterval): {
  nextDueOn: string | null;
  nextDueUsage: string | null;
} {
  assertMaintenanceInterval(interval);
  const anchor = interval.lastPerformedOn ?? interval.startsOn;
  return {
    nextDueOn:
      interval.intervalMonths === null ? null : addMonthsClamped(anchor, interval.intervalMonths),
    nextDueUsage:
      interval.intervalUsage === null
        ? null
        : add(interval.lastPerformedUsage ?? "0", interval.intervalUsage),
  };
}

export type MaintenanceStanding = "scheduled" | "due" | "overdue";

/**
 * Where a schedule stands today. By date it is due within its lead days and
 * overdue after the due date; by meter it is due once the reading reaches
 * the due value and overdue once it passes it. The worse of the two wins.
 */
export function maintenanceStanding(args: {
  today: string;
  nextDueOn: string | null;
  nextDueUsage: string | null;
  currentUsage: string | null;
  leadDays: number;
}): MaintenanceStanding {
  let standing: MaintenanceStanding = "scheduled";
  const worse = (next: MaintenanceStanding) => {
    if (next === "overdue" || (next === "due" && standing === "scheduled")) standing = next;
  };
  if (args.nextDueOn !== null) {
    const days = daysBetween(args.today, args.nextDueOn);
    if (days < 0) worse("overdue");
    else if (days <= args.leadDays) worse("due");
  }
  if (args.nextDueUsage !== null && args.currentUsage !== null) {
    const compared = cmp(args.currentUsage, args.nextDueUsage);
    if (compared > 0) worse("overdue");
    else if (compared === 0) worse("due");
  }
  return standing;
}

/** Stable identity of one due point, so each due point notifies once per stage. */
export function maintenanceDueKey(nextDueOn: string | null, nextDueUsage: string | null): string {
  return `${nextDueOn ?? "-"}|${nextDueUsage === null ? "-" : add(nextDueUsage, "0")}`;
}
