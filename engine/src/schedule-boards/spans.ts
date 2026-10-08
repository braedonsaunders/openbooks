/**
 * Booking spans: the instants a booking occupies, resolved from local clock
 * times in the board's time zone. Durations are whole minutes; no
 * floating-point arithmetic touches scheduled time.
 */
import { addCalendarDays, calendarDaysBetween, isIsoCalendarDate } from "../platform/civil-date.ts";
import { canonicalTimeZone, localTimeFields, resolveLocalTime } from "../platform/time-zone.ts";
import { ScheduleError } from "./errors.ts";

export interface BookingSpan {
  readonly spanMode: "day" | "timed";
  readonly timeZone: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly breakMinutes: number;
}

export interface DayDefinition {
  readonly timeZone: string;
  readonly dayStarts: string;
  readonly dayEnds: string;
  readonly dayBreakMinutes: number;
}

/** "HH:MM" or "HH:MM:SS" to minutes after midnight. */
export function clockMinutes(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value)) {
    throw new ScheduleError(`${field} needs a clock time such as 07:30.`, { code: "schedule_invalid_time" });
  }
  const [hours, minutes] = value.split(":").map(Number);
  return hours! * 60 + minutes!;
}

export function minutesClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function requireDate(value: unknown, field: string): string {
  if (!isIsoCalendarDate(value)) throw new ScheduleError(`${field} needs a real calendar date.`, { code: "schedule_invalid_date" });
  return value;
}

export function requireTimeZone(value: unknown): string {
  const zone = canonicalTimeZone(value);
  if (!zone) throw new ScheduleError("The time zone is unknown.", { code: "schedule_invalid_time_zone", remedy: "Choose a named time zone such as America/Toronto." });
  return zone;
}

function instant(date: string, minutes: number, timeZone: string, label: string): string {
  const resolved = resolveLocalTime({ date, time: minutesClock(minutes) }, timeZone);
  if (resolved.kind !== "ready" || resolved.choices.length === 0) {
    throw new ScheduleError(`${label} ${date} ${minutesClock(minutes)} does not exist in ${timeZone} because of a clock change.`, {
      code: "schedule_clock_change",
      remedy: "Choose another time for this date.",
    });
  }
  if (resolved.choices.length > 1) {
    throw new ScheduleError(`${label} ${date} ${minutesClock(minutes)} happens twice in ${timeZone} because of a clock change.`, {
      code: "schedule_clock_change",
      remedy: "Choose a time outside the repeated hour for this date.",
    });
  }
  return resolved.choices[0]!.instant;
}

function breakMinutes(value: unknown, wallMinutes: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 240) {
    throw new ScheduleError("The break needs a whole number of minutes from 0 through 240.", { code: "schedule_invalid_break" });
  }
  if ((value as number) >= wallMinutes) {
    throw new ScheduleError("The break leaves no working time.", { code: "schedule_invalid_break", remedy: "Shorten the break or lengthen the booking." });
  }
  return value as number;
}

/** A whole working day booked from the board's standard day. */
export function daySpan(day: DayDefinition, onDate: string): BookingSpan {
  const date = requireDate(onDate, "Booking date");
  const starts = clockMinutes(day.dayStarts.slice(0, 5), "Day start");
  const ends = clockMinutes(day.dayEnds.slice(0, 5), "Day end");
  if (ends <= starts) throw new ScheduleError("The board's working day must end after it starts.", { code: "schedule_invalid_time", remedy: "Correct the day hours in the board settings." });
  const timeZone = requireTimeZone(day.timeZone);
  return {
    spanMode: "day",
    timeZone,
    startsOn: date,
    endsOn: date,
    startsAt: instant(date, starts, timeZone, "Day start"),
    endsAt: instant(date, ends, timeZone, "Day end"),
    breakMinutes: breakMinutes(day.dayBreakMinutes, ends - starts),
  };
}

/**
 * A timed booking. An end at or before the start ends on the next day, so
 * overnight shifts are entered the way they are worked (22:00 to 06:00).
 */
export function timedSpan(input: { onDate: string; starts: string; ends: string; breakMinutes: number; timeZone: string }): BookingSpan {
  const date = requireDate(input.onDate, "Booking date");
  const starts = clockMinutes(input.starts, "Start");
  const ends = clockMinutes(input.ends, "End");
  const overnight = ends <= starts;
  const endsOn = overnight ? addCalendarDays(date, 1) : date;
  const timeZone = requireTimeZone(input.timeZone);
  const wall = (overnight ? ends + 1440 : ends) - starts;
  return {
    spanMode: "timed",
    timeZone,
    startsOn: date,
    endsOn,
    startsAt: instant(date, starts, timeZone, "Start"),
    endsAt: instant(endsOn, ends, timeZone, "End"),
    breakMinutes: breakMinutes(input.breakMinutes, wall),
  };
}

/** Elapsed whole minutes between two instants, less the planned break. */
export function workedMinutes(startsAt: string, endsAt: string, breakMinutesValue: number): number {
  const elapsed = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000);
  return Math.max(0, elapsed - breakMinutesValue);
}

/** The local clock time of an instant in a zone, as HH:MM. */
export function localClock(instantValue: string, timeZone: string): string {
  const fields = localTimeFields(instantValue, timeZone);
  return fields ? fields.time.slice(0, 5) : "";
}

/** Inclusive list of dates from `from` through `through`. */
export function datesBetween(from: string, through: string): string[] {
  const count = calendarDaysBetween(from, through);
  if (count < 0) throw new ScheduleError("The range ends before it starts.", { code: "schedule_invalid_range" });
  if (count > 62) throw new ScheduleError("A board shows at most 63 days at once.", { code: "schedule_invalid_range", remedy: "Choose a shorter range." });
  return Array.from({ length: count + 1 }, (_, index) => addCalendarDays(from, index));
}

/** The first day shown for a board range containing `anchor`. Ranges of a week or longer start on the board's week start. */
export function windowStart(anchor: string, rangeDays: number, weekStartsOn: number): string {
  const date = requireDate(anchor, "Date");
  if (rangeDays < 7) return date;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addCalendarDays(date, -((weekday - weekStartsOn + 7) % 7));
}
