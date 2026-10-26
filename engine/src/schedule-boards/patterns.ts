/**
 * Recurring shift patterns: pure definition and expansion.
 *
 * A pattern repeats every `cycleDays` days from `cycleAnchor`; each slot
 * names a cycle day and local clock times in the pattern's time zone. An end
 * at or before the start ends the next day, the way overnight shifts are
 * entered on the board. Occurrences resolve local clock times to instants
 * through the native time-zone rules on every date, so a shift keeps its
 * local hours across daylight-saving changes and is never produced by adding
 * fixed UTC hours. A clock time that does not exist on a date, or that
 * occurs twice, is reported as a problem until the occurrence is omitted or
 * its real instant is selected.
 */
import {
  addCalendarDays,
  calendarDaysBetween,
  inclusiveCalendarDays,
  isIsoCalendarDate,
} from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { resolveLocalTime, type ZonedTimeChoice } from "../platform/time-zone.ts";
import { ScheduleError } from "./errors.ts";
import { clockMinutes, minutesClock, requireTimeZone } from "./spans.ts";

export interface PatternSlot {
  readonly position: number;
  readonly starts: string;
  readonly ends: string;
  readonly breakMinutes: number;
  readonly qualificationTypeIds: readonly string[];
}

export interface PatternDefinition {
  readonly timeZone: string;
  readonly cycleDays: number;
  readonly cycleAnchor: string;
  readonly slots: readonly PatternSlot[];
}

/** An exception recorded for one occurrence (date and slot index). */
export type OccurrenceException =
  | { readonly kind: "omit"; readonly reason: string }
  | { readonly kind: "select_instant"; readonly startsAt: string; readonly endsAt: string };

export interface PatternOccurrence {
  readonly occursOn: string;
  readonly slotIndex: number;
  readonly timeZone: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly breakMinutes: number;
  readonly qualificationTypeIds: readonly string[];
}

export interface OccurrenceProblem {
  readonly occursOn: string;
  readonly slotIndex: number;
  readonly code:
    | "schedule_pattern_missing_time"
    | "schedule_pattern_repeated_time"
    | "schedule_pattern_selection_mismatch";
  readonly message: string;
  readonly remedy: string;
  /** The real instants of a repeated clock time, for an explicit selection. */
  readonly startChoices: readonly ZonedTimeChoice[];
  readonly endChoices: readonly ZonedTimeChoice[];
}

export interface PatternExpansion {
  readonly occurrences: readonly PatternOccurrence[];
  readonly omitted: readonly { readonly occursOn: string; readonly slotIndex: number }[];
  readonly problems: readonly OccurrenceProblem[];
}

/** The most occurrences one expansion produces. */
export const MAX_PATTERN_OCCURRENCES = 10000;
/** The longest window one expansion covers. */
export const MAX_PATTERN_WINDOW_DAYS = 366;

function invalid(message: string, remedy: string): ScheduleError {
  return new ScheduleError(message, { code: "schedule_pattern_invalid", remedy });
}

function whole(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(
      `${field} must be a whole number from ${minimum} through ${maximum}.`,
      "Correct the pattern definition.",
    );
  }
  return value as number;
}

function wallMinutes(slot: Pick<PatternSlot, "starts" | "ends">): { starts: number; ends: number } {
  const starts = clockMinutes(slot.starts, "Slot start");
  const raw = clockMinutes(slot.ends, "Slot end");
  return { starts, ends: raw <= starts ? raw + 1440 : raw };
}

function normalizeSlot(input: PatternSlot, cycleDays: number): PatternSlot {
  if (!input || typeof input !== "object")
    throw invalid("A pattern slot is incomplete.", "Enter its cycle day, start, end and break.");
  const position = whole(input.position, "The slot's cycle day", 0, cycleDays - 1);
  if (typeof input.starts !== "string" || typeof input.ends !== "string") {
    throw invalid(
      "A pattern slot needs a start and end clock time such as 07:30.",
      "Enter local clock times in hours and minutes.",
    );
  }
  const starts = input.starts.slice(0, 5),
    ends = input.ends.slice(0, 5);
  const wall = wallMinutes({ starts, ends });
  const breakMinutes = whole(input.breakMinutes, "The slot's break minutes", 0, 240);
  if (breakMinutes >= wall.ends - wall.starts)
    throw invalid(
      "A slot's break leaves no working time.",
      "Shorten the break or lengthen the slot.",
    );
  const requirements = input.qualificationTypeIds ?? [];
  if (!Array.isArray(requirements) || requirements.length > 100) {
    throw invalid(
      "A slot names at most 100 required qualification types.",
      "Review the slot's requirements.",
    );
  }
  const ids = requirements.map((id) => {
    if (!isUuid(id))
      throw invalid(
        "A required qualification type is not recognized.",
        "Choose native qualification types.",
      );
    return id.toLowerCase();
  });
  if (new Set(ids).size !== ids.length)
    throw invalid(
      "A qualification type appears twice on one slot.",
      "Keep one requirement for each type.",
    );
  return { position, starts, ends, breakMinutes, qualificationTypeIds: [...ids].sort() };
}

/**
 * Validate and canonicalize a pattern definition. Slots are ordered by cycle
 * day and start; they may not overlap, including where the last slot of the
 * cycle runs into the first slot of the next.
 */
export function normalizePattern(input: PatternDefinition): PatternDefinition {
  const cycleDays = whole(input.cycleDays, "The cycle length in days", 1, 366);
  if (!isIsoCalendarDate(input.cycleAnchor))
    throw invalid(
      "The cycle needs a real first date.",
      "Choose the calendar date that is day 1 of the cycle.",
    );
  const timeZone = requireTimeZone(input.timeZone);
  if (!Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > 1000) {
    throw invalid("A pattern needs 1 through 1000 slots.", "Add the working shifts of the cycle.");
  }
  const slots = input.slots
    .map((slot) => normalizeSlot(slot, cycleDays))
    .sort((a, b) => a.position - b.position || a.starts.localeCompare(b.starts));
  const cycleMinutes = cycleDays * 1440;
  const intervals = slots
    .flatMap((slot) => {
      const wall = wallMinutes(slot);
      const start = slot.position * 1440 + wall.starts,
        end = slot.position * 1440 + wall.ends;
      return end <= cycleMinutes
        ? [[start, end]]
        : [
            [start, cycleMinutes],
            [0, end - cycleMinutes],
          ];
    })
    .sort((a, b) => a[0]! - b[0]!);
  for (let index = 1; index < intervals.length; index++) {
    if (intervals[index]![0]! < intervals[index - 1]![1]!) {
      throw invalid(
        "Pattern slots overlap, including across the end of the cycle.",
        "Adjust the slots' days or clock times so no two slots share time.",
      );
    }
  }
  return { timeZone, cycleDays, cycleAnchor: input.cycleAnchor, slots };
}

/** The cycle day (0-based) a date falls on. */
export function cycleDayOn(
  pattern: Pick<PatternDefinition, "cycleDays" | "cycleAnchor">,
  date: string,
): number {
  const offset = calendarDaysBetween(pattern.cycleAnchor, date);
  return ((offset % pattern.cycleDays) + pattern.cycleDays) % pattern.cycleDays;
}

export function occurrenceKey(occursOn: string, slotIndex: number): string {
  return `${occursOn}:${slotIndex}`;
}

/**
 * Expand a pattern over an inclusive date window. Occurrences are ordered by
 * date and slot. Exceptions are keyed by `occurrenceKey`: an omission removes
 * the occurrence; a selected instant pair must be real occurrences of the
 * slot's clock times on that date.
 */
export function patternOccurrences(input: {
  pattern: PatternDefinition;
  from: string;
  through: string;
  exceptions?: ReadonlyMap<string, OccurrenceException>;
}): PatternExpansion {
  if (
    !isIsoCalendarDate(input.from) ||
    !isIsoCalendarDate(input.through) ||
    input.through < input.from
  ) {
    throw new ScheduleError("The generation window needs a start and an end on or after it.", {
      code: "schedule_invalid_range",
    });
  }
  if (inclusiveCalendarDays(input.from, input.through) > MAX_PATTERN_WINDOW_DAYS) {
    throw new ScheduleError(
      `Bookings are generated at most ${MAX_PATTERN_WINDOW_DAYS} days at a time.`,
      { code: "schedule_invalid_range", remedy: "Choose a shorter window." },
    );
  }
  const pattern = normalizePattern(input.pattern);
  const occurrences: PatternOccurrence[] = [],
    omitted: { occursOn: string; slotIndex: number }[] = [],
    problems: OccurrenceProblem[] = [];
  for (let date = input.from; ; date = addCalendarDays(date, 1)) {
    const day = cycleDayOn(pattern, date);
    for (const [slotIndex, slot] of pattern.slots.entries()) {
      if (slot.position !== day) continue;
      const exception = input.exceptions?.get(occurrenceKey(date, slotIndex));
      if (exception?.kind === "omit") {
        omitted.push({ occursOn: date, slotIndex });
        continue;
      }
      const resolved = resolveOccurrence(
        pattern.timeZone,
        date,
        slotIndex,
        slot,
        exception?.kind === "select_instant" ? exception : null,
      );
      if ("problem" in resolved) problems.push(resolved.problem);
      else occurrences.push(resolved.occurrence);
      if (occurrences.length > MAX_PATTERN_OCCURRENCES) {
        throw new ScheduleError(
          `One generation produces at most ${MAX_PATTERN_OCCURRENCES} bookings.`,
          { code: "schedule_invalid_range", remedy: "Choose a shorter window." },
        );
      }
    }
    if (date === input.through) break;
  }
  return { occurrences, omitted, problems };
}

function resolveOccurrence(
  timeZone: string,
  occursOn: string,
  slotIndex: number,
  slot: PatternSlot,
  selection: { startsAt: string; endsAt: string } | null,
): { occurrence: PatternOccurrence } | { problem: OccurrenceProblem } {
  const wall = wallMinutes(slot);
  const overnight = wall.ends >= 1440;
  let endsOn: string;
  try {
    endsOn = overnight ? addCalendarDays(occursOn, 1) : occursOn;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new ScheduleError("The shift would end after the supported calendar.", {
      code: "schedule_invalid_date",
      remedy: "Choose dates within years 0001 through 9999.",
    });
  }
  const start = resolveLocalTime({ date: occursOn, time: minutesClock(wall.starts) }, timeZone);
  const end = resolveLocalTime({ date: endsOn, time: minutesClock(wall.ends % 1440) }, timeZone);
  const base = { occursOn, slotIndex, startChoices: start.choices, endChoices: end.choices };
  const label = `${occursOn} ${slot.starts}–${slot.ends}`;
  if (start.kind !== "ready" || end.kind !== "ready") {
    return {
      problem: {
        ...base,
        code: "schedule_pattern_missing_time",
        message: `The shift on ${label} falls in a clock change in ${timeZone}; one of its times does not exist that day.`,
        remedy:
          "Omit this occurrence with a reason, or book the shift on the board with times that exist.",
      },
    };
  }
  let startsAt: string, endsAt: string;
  if (selection) {
    if (
      !start.choices.some((choice) => choice.instant === selection.startsAt) ||
      !end.choices.some((choice) => choice.instant === selection.endsAt)
    ) {
      return {
        problem: {
          ...base,
          code: "schedule_pattern_selection_mismatch",
          message: `The selected instants for ${label} are not real occurrences of its clock times in ${timeZone}.`,
          remedy:
            "Revoke the selection and choose one of the listed occurrences, or omit the occurrence.",
        },
      };
    }
    startsAt = selection.startsAt;
    endsAt = selection.endsAt;
  } else if (start.choices.length !== 1 || end.choices.length !== 1) {
    return {
      problem: {
        ...base,
        code: "schedule_pattern_repeated_time",
        message: `A time of the shift on ${label} happens twice in ${timeZone} because of a clock change.`,
        remedy:
          "Select which occurrence the shift starts and ends at, or omit this occurrence with a reason.",
      },
    };
  } else {
    startsAt = start.choices[0]!.instant;
    endsAt = end.choices[0]!.instant;
  }
  const elapsedMinutes = (Date.parse(endsAt) - Date.parse(startsAt)) / 60000;
  if (elapsedMinutes <= slot.breakMinutes || elapsedMinutes > 48 * 60) {
    return {
      problem: {
        ...base,
        code: "schedule_pattern_selection_mismatch",
        message: `The shift on ${label} leaves no working time after its break or lasts more than 48 hours.`,
        remedy:
          "Revoke the selection and choose the shift's real start and end, or omit the occurrence.",
      },
    };
  }
  return {
    occurrence: {
      occursOn,
      slotIndex,
      timeZone,
      startsOn: occursOn,
      endsOn,
      startsAt,
      endsAt,
      breakMinutes: slot.breakMinutes,
      qualificationTypeIds: slot.qualificationTypeIds,
    },
  };
}
