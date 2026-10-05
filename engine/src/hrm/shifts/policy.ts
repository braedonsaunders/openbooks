import { createHash } from "node:crypto";
import { addCalendarDays, inclusiveCalendarDays, isIsoCalendarDate } from "../../platform/civil-date.ts";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { canonicalTimeZone, resolveLocalTime } from "../../platform/time-zone.ts";
import { cyclePositionOn, type ResolvedWorkSchedule } from "../../payroll/work-schedules.ts";
import { validateClockSequence, type ClockKind } from "../field-time/pure.ts";
import { FieldTimeError } from "../field-time/errors.ts";
import { inputGuards } from "../input-guards.ts";

export class ShiftError extends Error {
  readonly status = 422;
}
export const { requireUuid } = inputGuards(message => new ShiftError(message));

export interface ShiftSlot {
  readonly position: number;
  readonly starts: string;
  readonly ends: string;
  readonly endDayOffset: 0 | 1;
  readonly plannedBreakSeconds: number;
  readonly qualificationTypeIds: readonly string[];
}
export interface ShiftPattern {
  /** Frozen native normal-work cycle; operational publication never edits its hours. */
  readonly schedule: ResolvedWorkSchedule;
  readonly timeZone: string;
  readonly slots: readonly ShiftSlot[];
}
export interface ShiftOccurrence {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly timeZone: string;
  readonly durationSeconds: number;
  readonly plannedBreakSeconds: number;
  readonly qualificationTypeIds: readonly string[];
}

function whole(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new ShiftError(`${name} must be a whole number from 0 through ${maximum} — review the scheduling definition.`);
  }
  return value as number;
}
function clock(value: unknown, name: string): string {
  if (typeof value !== "string" || /\s/.test(value) || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    throw new ShiftError(`${name} needs a real local clock time — enter hours and minutes, with optional seconds.`);
  }
  return value.length === 5 ? `${value}:00` : value;
}
function zone(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) {
    throw new ShiftError("Shift time zone is unknown — choose a named time zone such as America/Toronto.");
  }
  const result = canonicalTimeZone(value);
  if (!result) throw new ShiftError("Shift time zone is unknown — choose a named time zone such as America/Toronto.");
  return result;
}
function clockSeconds(value: string): number {
  const [hours, minutes, seconds] = value.split(":").map(Number);
  return hours! * 3600 + minutes! * 60 + seconds!;
}
function slot(input: ShiftSlot, cycleDays: number): ShiftSlot {
  const position = whole(input.position, "Cycle position", cycleDays - 1);
  const starts = clock(input.starts, "Shift start"), ends = clock(input.ends, "Shift end");
  const endDayOffset = whole(input.endDayOffset, "Shift end day offset", 1) as 0 | 1;
  const wallSeconds = clockSeconds(ends) + endDayOffset * 86400 - clockSeconds(starts);
  if (wallSeconds <= 0 || wallSeconds > 86400) {
    throw new ShiftError("A shift must end after its start and span at most one local day — correct its times and next-day setting.");
  }
  const plannedBreakSeconds = whole(input.plannedBreakSeconds, "Planned break seconds", wallSeconds - 1);
  if (!Array.isArray(input.qualificationTypeIds) || input.qualificationTypeIds.length > 100) {
    throw new ShiftError("Shift qualifications need at most 100 native qualification types — review the selected requirements.");
  }
  const ids = input.qualificationTypeIds.map(id => requireUuid(id, "Qualification type"));
  if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
    throw new ShiftError("A qualification type appears more than once — keep one requirement for each native type.");
  }
  return { position, starts, ends, endDayOffset, plannedBreakSeconds, qualificationTypeIds: ids.map(id => id.toLowerCase()).sort() };
}

/** The native cycle supplies recurrence; this definition adds operational clock times. */
export function shiftPattern(input: ShiftPattern): ShiftPattern {
  const schedule = structuredClone(input.schedule);
  requireUuid(schedule.id, "Normal work schedule");
  if (schedule.pattern !== "cycle" || !isIsoCalendarDate(schedule.cycleAnchor) || !Number.isSafeInteger(schedule.cycleDays) || schedule.cycleDays! < 1 || schedule.cycleDays! > 366) {
    throw new ShiftError("Recurring shifts need a native repeating work schedule — select a configured cycle, or create individual shifts for varying hours.");
  }
  if (!Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > 1000) {
    throw new ShiftError("A recurring shift definition needs 1 through 1000 slots — add its working positions before approval.");
  }
  const slots = input.slots.map(value => slot(value, schedule.cycleDays!)).sort((a, b) => a.position - b.position || a.starts.localeCompare(b.starts));
  const cycleSeconds = schedule.cycleDays! * 86400;
  const intervals = slots.flatMap(value => {
    const start = value.position * 86400 + clockSeconds(value.starts);
    const end = (value.position + value.endDayOffset) * 86400 + clockSeconds(value.ends);
    return end <= cycleSeconds ? [{ start, end }] : [{ start, end: cycleSeconds }, { start: 0, end: end - cycleSeconds }];
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < intervals.length; index++) {
    if (intervals[index]!.start < intervals[index - 1]!.end) {
      throw new ShiftError("Recurring shift slots overlap, including at the cycle boundary — adjust their clock times before approval.");
    }
  }
  return { schedule, timeZone: zone(input.timeZone), slots };
}

function selectedInstant(date: string, time: string, timeZone: string, selected: string | undefined, label: string): string {
  const result = resolveLocalTime({ date, time }, timeZone);
  if (result.kind !== "ready") {
    throw new ShiftError(`${label} ${date} ${time} does not exist in ${timeZone} — choose another clock time or omit this occurrence from publication.`);
  }
  if (selected !== undefined) {
    if (!result.choices.some(choice => choice.instant === selected)) {
      throw new ShiftError(`${label} occurrence does not match ${date} ${time} in ${timeZone} — choose one of its actual clock-time occurrences.`);
    }
    return selected;
  }
  if (result.choices.length !== 1) {
    throw new ShiftError(`${label} ${date} ${time} occurs twice in ${timeZone} — explicitly select its earlier or later occurrence before publication.`);
  }
  return result.choices[0]!.instant;
}

/** Published instants preserve the chosen occurrence; recurrence never adds 24 UTC hours. */
export function shiftOccurrence(input: { onDate: string; timeZone: string; slot: ShiftSlot; startsAt?: string; endsAt?: string }): ShiftOccurrence {
  if (!isIsoCalendarDate(input.onDate)) throw new ShiftError("Shift date is invalid — choose a real calendar date.");
  const declared = slot(input.slot, 366), timeZone = zone(input.timeZone);
  let endsOn: string;
  try { endsOn = addCalendarDays(input.onDate, declared.endDayOffset); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new ShiftError("Shift end exceeds the supported calendar — choose an end within years 0001 through 9999.");
  }
  const startsAt = selectedInstant(input.onDate, declared.starts, timeZone, input.startsAt, "Shift start");
  const endsAt = selectedInstant(endsOn, declared.ends, timeZone, input.endsAt, "Shift end");
  const durationSeconds = (Date.parse(endsAt) - Date.parse(startsAt)) / 1000;
  if (durationSeconds <= declared.plannedBreakSeconds || durationSeconds > 48 * 3600) {
    throw new ShiftError("The selected shift instants leave no working time or exceed 48 hours — review its occurrences and planned break.");
  }
  return { startsAt, endsAt, startsOn: input.onDate, endsOn, timeZone, durationSeconds, plannedBreakSeconds: declared.plannedBreakSeconds, qualificationTypeIds: declared.qualificationTypeIds };
}

export function recurringShiftOccurrences(input: {
  pattern: ShiftPattern; from: string; through: string;
  occurrences?: Readonly<Record<string, { startsAt?: string; endsAt?: string }>>;
}): readonly ShiftOccurrence[] {
  if (!isIsoCalendarDate(input.from) || !isIsoCalendarDate(input.through) || input.through < input.from || inclusiveCalendarDays(input.from, input.through) > 366) {
    throw new ShiftError("Shift publication needs an ordered window of at most 366 days — choose a shorter calendar range.");
  }
  const pattern = shiftPattern(input.pattern), result: ShiftOccurrence[] = [], consumed = new Set<string>();
  for (let date = input.from; date <= input.through;) {
    const position = cyclePositionOn(pattern.schedule, date);
    for (const [index, value] of pattern.slots.entries()) {
      if (value.position === position) {
        const key = `${date}:${index}`;
        const selected = input.occurrences?.[key];
        consumed.add(key);
        result.push(shiftOccurrence({ onDate: date, timeZone: pattern.timeZone, slot: value, startsAt: selected?.startsAt, endsAt: selected?.endsAt }));
      }
    }
    if (date === input.through) break;
    date = addCalendarDays(date, 1);
  }
  for (const key of Object.keys(input.occurrences ?? {})) {
    if (!consumed.has(key)) throw new ShiftError(`Selected occurrence ${key} does not identify a published shift slot — reload the publication preview and choose its actual occurrence.`);
  }
  return result;
}

export interface AttendancePolicy {
  readonly captureBeforeSeconds: number;
  readonly captureAfterSeconds: number;
  readonly lateGraceSeconds: number;
  readonly earlyGraceSeconds: number;
}
export interface DeviceCheckIn {
  readonly id: string;
  readonly kind: Exclude<ClockKind, "switch">;
  readonly occurredAt: string;
}
export interface AttendanceObservation {
  readonly status: "waiting_for_sync" | "absent" | "present";
  readonly completeThrough: string | null;
  readonly eventIds: readonly string[];
  readonly firstIn: string | null;
  readonly lastOut: string | null;
  readonly presenceMilliseconds: number | null;
  readonly breakMilliseconds: number | null;
  readonly late: boolean | null;
  readonly leftEarly: boolean | null;
  readonly evidenceHash: string;
}
function instant(value: unknown, name: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !isIsoCalendarDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ShiftError(`${name} needs an exact canonical UTC instant with milliseconds — preserve the source time zone when converting its timestamp.`);
  }
  return Date.parse(value);
}
export function attendancePolicy(input: AttendancePolicy): AttendancePolicy {
  return {
    captureBeforeSeconds: whole(input.captureBeforeSeconds, "Capture before seconds", 12 * 3600),
    captureAfterSeconds: whole(input.captureAfterSeconds, "Capture after seconds", 12 * 3600),
    lateGraceSeconds: whole(input.lateGraceSeconds, "Late grace seconds", 12 * 3600),
    earlyGraceSeconds: whole(input.earlyGraceSeconds, "Early grace seconds", 12 * 3600),
  };
}

/** Presence is source evidence, never an approved time entry or a payroll amount. */
export function observeAttendance(input: {
  shift: Pick<ShiftOccurrence, "startsAt" | "endsAt">; policy: AttendancePolicy;
  completeThrough: string | null; events: readonly DeviceCheckIn[];
}): AttendanceObservation {
  const policy = attendancePolicy(input.policy), starts = instant(input.shift.startsAt, "Shift start"), ends = instant(input.shift.endsAt, "Shift end");
  if (ends <= starts || ends - starts > 48 * 3600000) throw new ShiftError("Attendance needs an ordered shift of at most 48 hours — correct the planned instants.");
  const from = starts - policy.captureBeforeSeconds * 1000, through = ends + policy.captureAfterSeconds * 1000;
  const complete = input.completeThrough === null ? null : instant(input.completeThrough, "Device synchronization watermark");
  if (!Array.isArray(input.events) || input.events.length > 10000) throw new ShiftError("Attendance needs at most 10000 source events for one shift — review the device import scope.");
  const unique = new Map<string, DeviceCheckIn>();
  for (const event of input.events) {
    const id = requireUuid(event.id, "Check-in identity").toLowerCase(), occurred = instant(event.occurredAt, "Check-in time");
    if (!["clock_in", "clock_out", "break_start", "break_end"].includes(event.kind)) throw new ShiftError("Check-in kind is undeclared — supply clock-in, clock-out, break start or break end from the source device.");
    if (occurred < from || occurred > through) throw new ShiftError(`Check-in ${id} is outside this shift's capture window — reconcile its shift assignment before processing attendance.`);
    const prior = unique.get(id);
    if (prior && (prior.kind !== event.kind || prior.occurredAt !== event.occurredAt)) throw new ShiftError(`Check-in identity ${id} carries different source content — preserve the original event and submit a separately identified correction.`);
    unique.set(id, { id, kind: event.kind, occurredAt: event.occurredAt });
  }
  const events = [...unique.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const evidenceHash = createHash("sha256").update(canonicalJson({ shift: input.shift, policy, completeThrough: input.completeThrough, events })).digest("hex");
  const base = { completeThrough: input.completeThrough, eventIds: events.map(event => event.id), firstIn: null, lastOut: null, presenceMilliseconds: null, breakMilliseconds: null, late: null, leftEarly: null, evidenceHash };
  if (complete === null || complete < through) return { ...base, status: "waiting_for_sync" };
  if (!events.length) return { ...base, status: "absent", presenceMilliseconds: 0, breakMilliseconds: 0, late: false, leftEarly: false };
  let clockedIn = false, onBreak = false, open = 0, breakStart = 0, priorTime: number | null = null;
  let gross = 0, breaks = 0, firstIn: string | null = null, lastOut: string | null = null;
  for (const event of events) {
    const at = instant(event.occurredAt, "Check-in time");
    if (priorTime !== null && at <= priorTime) throw new ShiftError(`Check-ins have indistinguishable times at ${event.occurredAt} — reconcile duplicate or unordered source events before processing.`);
    try { validateClockSequence(event.kind, { clockedIn, onBreak }); }
    catch (error) {
      if (!(error instanceof FieldTimeError)) throw error;
      throw new ShiftError(`Check-in ${event.id} has an inconsistent ${event.kind.replaceAll("_", "-")} sequence — reconcile its source events before processing attendance.`);
    }
    if (event.kind === "clock_in") { clockedIn = true; open = at; firstIn ??= event.occurredAt; }
    else if (event.kind === "clock_out") { gross += at - open; clockedIn = false; lastOut = event.occurredAt; }
    else if (event.kind === "break_start") { onBreak = true; breakStart = at; }
    else { breaks += at - breakStart; onBreak = false; }
    priorTime = at;
  }
  if (clockedIn || onBreak) throw new ShiftError(`Attendance has an unfinished clock-in or break after synchronization — reconcile the missing source event before processing this shift.`);
  return { ...base, status: "present", firstIn, lastOut, presenceMilliseconds: gross - breaks, breakMilliseconds: breaks,
    late: instant(firstIn, "First clock-in") > starts + policy.lateGraceSeconds * 1000,
    leftEarly: instant(lastOut, "Last clock-out") < ends - policy.earlyGraceSeconds * 1000 };
}
