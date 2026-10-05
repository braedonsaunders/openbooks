import { createHash } from "node:crypto";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { isIsoCalendarDate } from "../../platform/civil-date.ts";
import { inputGuards } from "../input-guards.ts";

export class TrainingError extends Error {
  readonly status = 422;
}

export const { requireUuid } = inputGuards((message) => new TrainingError(message));

export type TrainingPolicy = {
  readonly qualificationTypeId: string | null;
  readonly minimumAttendancePercent: number;
  readonly passingScore: number | null;
};

export function trainingText(value: unknown, name: string, limit = 2000): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > limit) {
    throw new TrainingError(`${name} needs 1 through ${limit} characters — enter a concise value before saving.`);
  }
  return value.trim();
}

export function trainingInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TrainingError(`${name} must be a whole number from 0 through ${maximum} — review the entered value.`);
  }
  return value as number;
}

export function trainingWindow(from: unknown, to: unknown) {
  if (!isIsoCalendarDate(from) || (to !== null && !isIsoCalendarDate(to)) || (typeof to === "string" && to < from)) {
    throw new TrainingError("Training effective dates must be real and ordered — choose an end on or after the start, or leave it open.");
  }
  return { effectiveFrom: from, effectiveTo: to };
}

export function trainingPolicy(input: TrainingPolicy): TrainingPolicy {
  return {
    qualificationTypeId: input.qualificationTypeId === null ? null : requireUuid(input.qualificationTypeId, "qualification type"),
    minimumAttendancePercent: trainingInteger(input.minimumAttendancePercent, "Minimum attendance percentage", 100),
    passingScore: input.passingScore === null ? null : trainingInteger(input.passingScore, "Passing score", 100),
  };
}

/** Explicit offsets identify instants even during repeated daylight-saving hours. */
export function trainingSessionWindow(startsAt: unknown, endsAt: unknown, timeZone: unknown) {
  const stamp = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new TrainingError("Session times need an explicit UTC or numeric offset — choose the time zone and exact start and end instants.");
    }
    const date = value.slice(0, 10);
    if (!isIsoCalendarDate(date) || !Number.isFinite(Date.parse(value))) {
      throw new TrainingError("Session time is invalid — choose a real date and time.");
    }
    const [, h, m, s, offsetH, offsetM] = /T(\d{2}):(\d{2}):(\d{2})(?:\.000)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)!;
    if (Number(h) > 23 || Number(m) > 59 || Number(s) > 59 || (offsetH !== undefined && (Number(offsetH) > 14 || Number(offsetM) > 59 || (Number(offsetH) === 14 && Number(offsetM) !== 0)))) {
      throw new TrainingError("Session time is invalid — choose a real time and UTC offset.");
    }
    return new Date(value);
  };
  const start = stamp(startsAt), end = stamp(endsAt);
  const zone = trainingText(timeZone, "Time zone", 128);
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { throw new TrainingError("Time zone is unknown — choose an IANA time zone such as America/Toronto."); }
  const seconds = (end.getTime() - start.getTime()) / 1000;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 31 * 86400) {
    throw new TrainingError("A training session must end after its start and last no more than 31 days — split longer courses into sessions.");
  }
  const civil = (value: Date) => {
    const parts = formatter.formatToParts(value);
    const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === name)!.value;
    return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
  };
  const startsOn = civil(start), endsOn = civil(end);
  if (!isIsoCalendarDate(startsOn) || !isIsoCalendarDate(endsOn)) throw new TrainingError("Session dates must be within years 0001 through 9999 — choose supported dates.");
  return { startsAt: start.toISOString(), endsAt: end.toISOString(), startsOn, endsOn, timeZone: zone, durationSeconds: seconds };
}

/** Integer cross-products keep attendance threshold decisions exact. */
export function trainingResult(policy: TrainingPolicy, durationSeconds: number, attendanceSeconds: unknown, score: unknown) {
  const declared = trainingPolicy(policy);
  const duration = trainingInteger(durationSeconds, "Session duration", 31 * 86400);
  if (duration === 0) throw new TrainingError("Session duration is missing — correct the session before recording results.");
  const attendance = trainingInteger(attendanceSeconds, "Attendance seconds", duration);
  const assessment = score === null ? null : trainingInteger(score, "Assessment score", 100);
  if (declared.passingScore !== null && assessment === null) throw new TrainingError("This course requires an assessment score — record the score before completing the participant.");
  if (declared.passingScore === null && assessment !== null) throw new TrainingError("This course has no assessment — leave the score empty, or create a course version that declares an assessment.");
  const attendancePassed = BigInt(attendance) * 100n >= BigInt(duration) * BigInt(declared.minimumAttendancePercent);
  const assessmentPassed = declared.passingScore === null || assessment! >= declared.passingScore;
  return { attendanceSeconds: attendance, score: assessment, attendancePassed, assessmentPassed, passed: attendancePassed && assessmentPassed };
}

export function trainingRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
