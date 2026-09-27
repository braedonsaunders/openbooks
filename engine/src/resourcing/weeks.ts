import {
  addCalendarDays,
  calendarDaysBetween,
  parseIsoDate,
} from "../platform/business-date.ts";
import { ResourcingRefusal } from "./errors.ts";

/** Sunday that starts the timesheet week containing a civil date. */
export function weekStartOf(date: string): string {
  const parsed = parseIsoDate(date);
  return addCalendarDays(date, -parsed.getUTCDay());
}

/** The Sunday-through-Saturday dates in a timesheet week. */
export function weekDates(sunday: string): string[] {
  if (weekStartOf(sunday) !== sunday) {
    throw new RangeError(`week start must be a Sunday: ${sunday}`);
  }
  return Array.from({ length: 7 }, (_, index) => addCalendarDays(sunday, index));
}

/** Inclusive Sunday week starts, oldest first. */
export function weeksBetween(firstSunday: string, lastSunday: string): string[] {
  if (weekStartOf(firstSunday) !== firstSunday) {
    throw new RangeError(`first week start must be a Sunday: ${firstSunday}`);
  }
  if (weekStartOf(lastSunday) !== lastSunday) {
    throw new RangeError(`last week start must be a Sunday: ${lastSunday}`);
  }
  const dayCount = calendarDaysBetween(firstSunday, lastSunday);
  if (dayCount < 0 || dayCount % 7 !== 0) {
    throw new RangeError("last Sunday must be on or after first Sunday");
  }
  return Array.from(
    { length: dayCount / 7 + 1 },
    (_, index) => addCalendarDays(firstSunday, index * 7),
  );
}

/** Validate Sunday week boundaries and return the inclusive number of weeks. */
export function assertSundayWindow(firstSunday: string, lastSunday: string): number {
  if (weekStartOf(firstSunday) !== firstSunday || weekStartOf(lastSunday) !== lastSunday) {
    throw new ResourcingRefusal(
      422,
      "invalid_week_range",
      "the first and last dates must be Sunday week boundaries",
      "choose Sunday dates for the first and last weeks",
      "firstSunday",
    );
  }
  const dayCount = calendarDaysBetween(firstSunday, lastSunday);
  if (dayCount < 0 || dayCount % 7 !== 0) {
    throw new ResourcingRefusal(
      422,
      "invalid_week_range",
      "the last week must be on or after the first week",
      "choose a last Sunday on or after the first Sunday",
      "lastSunday",
    );
  }
  return dayCount / 7 + 1;
}
