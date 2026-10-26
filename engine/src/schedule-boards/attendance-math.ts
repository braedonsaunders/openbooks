/**
 * Attendance observation: presence against a published booking.
 *
 * Presence is source evidence, never approved time or a payroll amount.
 * Device check-ins inside the booking's capture window are replayed as a
 * clock state machine; the latest check-in never proves completeness — only
 * every mapped device's declared watermark reaching the end of the capture
 * window does. Durations are whole milliseconds between exact instants.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { ScheduleError } from "./errors.ts";

export type AttendancePolicy = {
  readonly captureBeforeMinutes: number;
  readonly captureAfterMinutes: number;
  readonly lateGraceMinutes: number;
  readonly earlyGraceMinutes: number;
  readonly breakGraceMinutes: number;
};

export type CheckInKind = "clock_in" | "clock_out" | "break_start" | "break_end";

export type CheckIn = {
  readonly id: string;
  readonly kind: CheckInKind;
  readonly occurredAt: string;
};

export type AttendanceObservation = {
  readonly status: "waiting_for_sync" | "absent" | "present";
  readonly completeThrough: string | null;
  readonly eventIds: readonly string[];
  readonly firstIn: string | null;
  readonly lastOut: string | null;
  readonly presenceMilliseconds: number | null;
  readonly breakMilliseconds: number | null;
  readonly late: boolean | null;
  readonly leftEarly: boolean | null;
  readonly overBreak: boolean | null;
  readonly evidenceHash: string;
};

const MINUTE = 60_000;
const MAX_POLICY_MINUTES = 720;

function attendanceError(message: string, remedy: string): ScheduleError {
  return new ScheduleError(message, { code: "schedule_attendance_refused", remedy });
}

/** An exact canonical UTC instant with milliseconds, e.g. 2026-03-02T14:00:00.000Z. */
export function requireInstant(value: unknown, field: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !isIsoCalendarDate(value.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw attendanceError(
      `${field} needs an exact UTC instant with milliseconds.`,
      "Convert the source timestamp with its time zone to a UTC instant such as 2026-03-02T14:00:00.000Z.",
    );
  }
  return Date.parse(value);
}

export function attendancePolicy(input: AttendancePolicy): AttendancePolicy {
  const bound = (value: unknown, field: string): number => {
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 0 ||
      (value as number) > MAX_POLICY_MINUTES
    ) {
      throw attendanceError(
        `${field} must be a whole number of minutes from 0 through ${MAX_POLICY_MINUTES}.`,
        "Correct the board's attendance policy.",
      );
    }
    return value as number;
  };
  return {
    captureBeforeMinutes: bound(input.captureBeforeMinutes, "Capture before"),
    captureAfterMinutes: bound(input.captureAfterMinutes, "Capture after"),
    lateGraceMinutes: bound(input.lateGraceMinutes, "Late grace"),
    earlyGraceMinutes: bound(input.earlyGraceMinutes, "Early leave grace"),
    breakGraceMinutes: bound(input.breakGraceMinutes, "Break grace"),
  };
}

/** The inclusive instants whose check-ins belong to a booking. */
export function captureWindow(
  booking: { startsAt: string; endsAt: string },
  policy: AttendancePolicy,
): { from: string; through: string } {
  const starts = requireInstant(booking.startsAt, "Booking start"),
    ends = requireInstant(booking.endsAt, "Booking end");
  const checked = attendancePolicy(policy);
  return {
    from: new Date(starts - checked.captureBeforeMinutes * MINUTE).toISOString(),
    through: new Date(ends + checked.captureAfterMinutes * MINUTE).toISOString(),
  };
}

export function observeAttendance(input: {
  booking: { startsAt: string; endsAt: string; breakMinutes: number };
  policy: AttendancePolicy;
  completeThrough: string | null;
  events: readonly CheckIn[];
}): AttendanceObservation {
  const policy = attendancePolicy(input.policy);
  const starts = requireInstant(input.booking.startsAt, "Booking start"),
    ends = requireInstant(input.booking.endsAt, "Booking end");
  if (ends <= starts || ends - starts > 48 * 60 * MINUTE)
    throw attendanceError(
      "Attendance needs a booking of at most 48 hours that ends after it starts.",
      "Correct the booking times.",
    );
  if (!Number.isSafeInteger(input.booking.breakMinutes) || input.booking.breakMinutes < 0)
    throw attendanceError(
      "The booking's planned break is not a whole number of minutes.",
      "Reload the booking.",
    );
  const from = starts - policy.captureBeforeMinutes * MINUTE,
    through = ends + policy.captureAfterMinutes * MINUTE;
  const complete =
    input.completeThrough === null
      ? null
      : requireInstant(input.completeThrough, "Device completeness");
  if (!Array.isArray(input.events) || input.events.length > 10000)
    throw attendanceError(
      "A booking is observed from at most 10000 check-ins.",
      "Review the device import scope.",
    );
  const unique = new Map<string, CheckIn>();
  for (const event of input.events) {
    if (!isUuid(event.id))
      throw attendanceError(
        "A check-in identity is not recognized.",
        "Reload the device check-ins.",
      );
    const id = event.id.toLowerCase(),
      occurred = requireInstant(event.occurredAt, "Check-in time");
    if (!["clock_in", "clock_out", "break_start", "break_end"].includes(event.kind)) {
      throw attendanceError(
        "A check-in kind is undeclared.",
        "Supply clock-in, clock-out, break start or break end from the device.",
      );
    }
    if (occurred < from || occurred > through) {
      throw attendanceError(
        `Check-in ${id} is outside this booking's capture window.`,
        "Reconcile which booking the check-in belongs to before processing attendance.",
      );
    }
    const prior = unique.get(id);
    if (prior && (prior.kind !== event.kind || prior.occurredAt !== event.occurredAt)) {
      throw attendanceError(
        `Check-in ${id} appears with different content.`,
        "Keep the original check-in and import a separately identified correction.",
      );
    }
    unique.set(id, { id, kind: event.kind, occurredAt: event.occurredAt });
  }
  const events = [...unique.values()].sort(
    (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
  );
  const evidenceHash = createHash("sha256")
    .update(
      canonicalJson({
        booking: input.booking,
        policy,
        completeThrough: input.completeThrough,
        events,
      }),
    )
    .digest("hex");
  const base = {
    completeThrough: input.completeThrough,
    eventIds: events.map((event) => event.id),
    firstIn: null,
    lastOut: null,
    presenceMilliseconds: null,
    breakMilliseconds: null,
    late: null,
    leftEarly: null,
    overBreak: null,
    evidenceHash,
  };
  if (complete === null || complete < through) return { ...base, status: "waiting_for_sync" };
  if (!events.length)
    return {
      ...base,
      status: "absent",
      presenceMilliseconds: 0,
      breakMilliseconds: 0,
      late: false,
      leftEarly: false,
      overBreak: false,
    };
  let state: "out" | "in" | "break" = "out",
    opened = 0,
    breakStart = 0,
    priorTime: number | null = null;
  let gross = 0,
    breaks = 0,
    firstIn: string | null = null,
    lastOut: string | null = null;
  for (const event of events) {
    const at = Date.parse(event.occurredAt);
    if (priorTime !== null && at <= priorTime) {
      throw attendanceError(
        `Check-ins have indistinguishable times at ${event.occurredAt}.`,
        "Reconcile duplicate or unordered source check-ins before processing attendance.",
      );
    }
    if (state === "out" && event.kind === "clock_in") {
      state = "in";
      opened = at;
      firstIn ??= event.occurredAt;
    } else if (state === "in" && event.kind === "break_start") {
      state = "break";
      breakStart = at;
    } else if (state === "break" && event.kind === "break_end") {
      state = "in";
      breaks += at - breakStart;
    } else if (state === "in" && event.kind === "clock_out") {
      state = "out";
      gross += at - opened;
      lastOut = event.occurredAt;
    } else {
      throw attendanceError(
        `Check-in ${event.id} has an inconsistent ${event.kind.replaceAll("_", "-")} sequence.`,
        "Reconcile the missing or contradictory source check-in before processing attendance.",
      );
    }
    priorTime = at;
  }
  if (state !== "out")
    throw attendanceError(
      "Attendance has an unfinished clock-in or break after synchronization.",
      "Reconcile the missing source check-in before processing this booking.",
    );
  return {
    ...base,
    status: "present",
    firstIn,
    lastOut,
    presenceMilliseconds: gross - breaks,
    breakMilliseconds: breaks,
    late: Date.parse(firstIn!) > starts + policy.lateGraceMinutes * MINUTE,
    leftEarly: Date.parse(lastOut!) < ends - policy.earlyGraceMinutes * MINUTE,
    overBreak: breaks > (input.booking.breakMinutes + policy.breakGraceMinutes) * MINUTE,
  };
}
