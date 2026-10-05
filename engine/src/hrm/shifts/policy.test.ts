import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedWorkSchedule } from "../../payroll/work-schedules.ts";
import { attendancePolicy, observeAttendance, recurringShiftOccurrences, shiftOccurrence, shiftPattern, type DeviceCheckIn, type ShiftSlot } from "./policy.ts";

const schedule: ResolvedWorkSchedule = {
  id: "10000000-0000-4000-8000-000000000001", name: "Weekly", scope: "employee", pattern: "cycle",
  cycleDays: 7, cycleAnchor: "2026-03-02", days: [{ dayIndex: 0, hours: "8.0000" }], effectiveFrom: "2026-01-01",
};
const slot: ShiftSlot = { position: 0, starts: "09:00", ends: "17:00", endDayOffset: 0, plannedBreakSeconds: 1800, qualificationTypeIds: [] };
const pattern = { schedule, timeZone: "America/Toronto", slots: [slot] };
const shift = { startsAt: "2026-03-02T14:00:00.000Z", endsAt: "2026-03-02T22:00:00.000Z" };
const policy = { captureBeforeSeconds: 3600, captureAfterSeconds: 3600, lateGraceSeconds: 300, earlyGraceSeconds: 300 };
const event = (index: number, kind: DeviceCheckIn["kind"], time: string): DeviceCheckIn => ({
  id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind, occurredAt: `2026-03-02T${time}Z`,
});
const input = { shift, policy, completeThrough: "2026-03-02T23:00:00.000Z", events: [event(1, "clock_in", "14:00:00.000"), event(2, "clock_out", "22:00:00.000")] };

test("native cycles retain local clock times across daylight saving and freeze their source independently", () => {
  const frozen = shiftPattern(pattern);
  frozen.schedule.days[0]!.hours = "7.0000";
  assert.equal(schedule.days[0]!.hours, "8.0000", "operational definitions cannot mutate normal payroll hours");
  const shifts = recurringShiftOccurrences({ pattern, from: "2026-03-02", through: "2026-03-09" });
  assert.deepEqual(shifts.map(value => value.startsAt), ["2026-03-02T14:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
  assert.deepEqual(shifts.map(value => value.durationSeconds), [28800, 28800]);
  assert.throws(() => shiftPattern({ ...pattern, schedule: { ...schedule, pattern: "varies" } }), /native repeating work schedule.*individual shifts/);
});

test("publication refuses missing and repeated clock times until a real occurrence is selected", () => {
  const at = (date: string, overrides = {}) => shiftOccurrence({ onDate: date, timeZone: pattern.timeZone, slot: { ...slot, starts: "01:30", ends: "04:00" }, ...overrides });
  assert.throws(() => at("2026-11-01"), /Shift start.*occurs twice.*explicitly select/);
  assert.equal(at("2026-11-01", { startsAt: "2026-11-01T06:30:00.000Z" }).durationSeconds, 9000);
  assert.throws(() => at("2026-11-01", { startsAt: "2026-11-01T07:30:00.000Z" }), /does not match.*actual clock-time occurrences/);
  assert.throws(() => at("2026-03-08", { slot: { ...slot, starts: "02:30", ends: "04:00" } }), /does not exist.*choose another clock time/);
  assert.equal(at("2026-10-31", { slot: { ...slot, starts: "09:00", ends: "09:00", endDayOffset: 1 } }).durationSeconds, 25 * 3600);
});

test("cycle-boundary overlap and unconfigured attendance bounds cannot publish plausible answers", () => {
  const overnight = { ...slot, position: 6, starts: "23:00", ends: "10:00", endDayOffset: 1 as const };
  assert.throws(() => shiftPattern({ ...pattern, slots: [slot, overnight] }), /overlap.*cycle boundary/);
  assert.throws(() => recurringShiftOccurrences({ pattern, from: "2026-01-01", through: "2027-01-02" }), /at most 366 days/);
  assert.throws(() => recurringShiftOccurrences({ pattern, from: "2026-03-02", through: "2026-03-02", occurrences: { "2026-03-03:0": {} } }), /does not identify.*actual occurrence/);
  assert.throws(() => shiftOccurrence({ onDate: "9999-12-31", timeZone: "UTC", slot: { ...slot, starts: "23:00", ends: "01:00", endDayOffset: 1 } }), /exceeds the supported calendar/);
  for (const value of [undefined, null, -1, 1.5, NaN, 43201]) assert.throws(() => attendancePolicy({ ...policy, captureAfterSeconds: value as number }), /Capture after seconds.*whole number/);
});

test("the latest check-in never proves completeness; only the declared capture watermark closes attendance", () => {
  for (const completeThrough of [null, "2026-03-02T22:59:59.999Z"]) {
    const pending = observeAttendance({ ...input, completeThrough });
    assert.equal(pending.status, "waiting_for_sync"); assert.equal(pending.presenceMilliseconds, null);
  }
  assert.equal(observeAttendance(input).status, "present");
  assert.equal(observeAttendance({ ...input, events: [], completeThrough: null }).status, "waiting_for_sync");
  const absent = observeAttendance({ ...input, events: [] });
  assert.equal(absent.status, "absent"); assert.equal(absent.presenceMilliseconds, 0);
});

test("attendance preserves actual milliseconds and recorded breaks without manufacturing approved paid time", () => {
  const events = [event(1, "clock_in", "14:05:00.001"), event(2, "break_start", "18:00:00.000"), event(3, "break_end", "18:30:00.000"), event(4, "clock_out", "21:54:59.999")];
  const observed = observeAttendance({ ...input, events });
  assert.equal(observed.presenceMilliseconds, 26399998); assert.equal(observed.breakMilliseconds, 1800000);
  assert.equal(observed.late, true); assert.equal(observed.leftEarly, true);
  assert.equal(observeAttendance({ ...input, events: [...events].reverse().concat(events[0]!) }).evidenceHash, observed.evidenceHash);
  assert.notEqual(observeAttendance({ ...input, events, policy: { ...policy, lateGraceSeconds: 301 } }).evidenceHash, observed.evidenceHash);
});

test("finalized device records refuse contradictory identities, unfinished pairs and ambiguous chronology by name", () => {
  assert.throws(() => observeAttendance({ ...input, events: [input.events[0]!] }), /unfinished.*missing source event/);
  assert.throws(() => observeAttendance({ ...input, events: [input.events[1]!] }), /inconsistent clock-out.*reconcile.*source/);
  assert.throws(() => observeAttendance({ ...input, events: [input.events[0]!, { ...input.events[0]!, kind: "clock_out" }] }), /identity.*different source content.*original event/);
  assert.throws(() => observeAttendance({ ...input, events: [input.events[0]!, event(3, "clock_out", "14:00:00.000")] }), /indistinguishable times.*reconcile/);
  assert.throws(() => observeAttendance({ ...input, events: [event(3, "clock_in", "12:59:59.999")] }), /outside.*capture window.*assignment/);
  assert.throws(() => observeAttendance({ ...input, completeThrough: "2026-02-30T23:00:00.000Z" }), /watermark.*exact canonical UTC/);
});
