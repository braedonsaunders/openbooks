import assert from "node:assert/strict";
import test from "node:test";
import {
  attendancePolicy,
  captureWindow,
  observeAttendance,
  type CheckIn,
} from "./attendance-math.ts";

const booking = {
  startsAt: "2026-03-02T14:00:00.000Z",
  endsAt: "2026-03-02T22:00:00.000Z",
  breakMinutes: 30,
};
const policy = {
  captureBeforeMinutes: 60,
  captureAfterMinutes: 60,
  lateGraceMinutes: 5,
  earlyGraceMinutes: 5,
  breakGraceMinutes: 10,
};
const event = (index: number, kind: CheckIn["kind"], time: string): CheckIn => ({
  id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  kind,
  occurredAt: `2026-03-02T${time}Z`,
});
const complete = "2026-03-02T23:00:00.000Z";
const input = {
  booking,
  policy,
  completeThrough: complete,
  events: [event(1, "clock_in", "14:00:00.000"), event(2, "clock_out", "22:00:00.000")],
};

test("only every mapped device's declared watermark closes attendance; the latest check-in never does", () => {
  for (const completeThrough of [null, "2026-03-02T22:59:59.999Z"]) {
    const pending = observeAttendance({ ...input, completeThrough });
    assert.equal(pending.status, "waiting_for_sync");
    assert.equal(pending.presenceMilliseconds, null);
  }
  assert.equal(observeAttendance(input).status, "present");
  const absent = observeAttendance({ ...input, events: [] });
  assert.deepEqual(
    [
      absent.status,
      absent.presenceMilliseconds,
      absent.breakMilliseconds,
      absent.late,
      absent.leftEarly,
      absent.overBreak,
    ],
    ["absent", 0, 0, false, false, false],
  );
});

test("presence keeps exact milliseconds and flags late arrival, early leave and long breaks", () => {
  const events = [
    event(1, "clock_in", "14:05:00.001"),
    event(2, "break_start", "18:00:00.000"),
    event(3, "break_end", "18:40:00.001"),
    event(4, "clock_out", "21:54:59.999"),
  ];
  const observed = observeAttendance({ ...input, events });
  assert.equal(observed.breakMilliseconds, 2400001);
  assert.equal(observed.presenceMilliseconds, 25799997);
  assert.deepEqual([observed.late, observed.leftEarly, observed.overBreak], [true, true, true]);
  const onTime = observeAttendance({
    ...input,
    events: [
      event(1, "clock_in", "14:05:00.000"),
      event(2, "break_start", "18:00:00.000"),
      event(3, "break_end", "18:40:00.000"),
      event(4, "clock_out", "21:55:00.000"),
    ],
  });
  assert.deepEqual(
    [onTime.late, onTime.leftEarly, onTime.overBreak],
    [false, false, false],
    "grace bounds are inclusive",
  );
  assert.equal(
    observeAttendance({ ...input, events: [...events].reverse().concat(events[0]!) }).evidenceHash,
    observed.evidenceHash,
  );
  assert.notEqual(
    observeAttendance({ ...input, events, policy: { ...policy, lateGraceMinutes: 6 } })
      .evidenceHash,
    observed.evidenceHash,
  );
});

test("finalized check-ins refuse contradictory identities, unfinished pairs and ambiguous chronology", () => {
  assert.throws(
    () => observeAttendance({ ...input, events: [input.events[0]!] }),
    /unfinished clock-in or break/,
  );
  assert.throws(
    () => observeAttendance({ ...input, events: [input.events[1]!] }),
    /inconsistent clock-out sequence/,
  );
  assert.throws(
    () =>
      observeAttendance({
        ...input,
        events: [input.events[0]!, { ...input.events[0]!, kind: "clock_out" }],
      }),
    /different content/,
  );
  assert.throws(
    () =>
      observeAttendance({
        ...input,
        events: [input.events[0]!, event(3, "clock_out", "14:00:00.000")],
      }),
    /indistinguishable times/,
  );
  assert.throws(
    () => observeAttendance({ ...input, events: [event(3, "clock_in", "12:59:59.999")] }),
    /outside this booking's capture window/,
  );
  assert.throws(
    () => observeAttendance({ ...input, completeThrough: "2026-02-30T23:00:00.000Z" }),
    /exact UTC instant/,
  );
  for (const value of [undefined, null, -1, 1.5, Number.NaN, 721]) {
    assert.throws(
      () => attendancePolicy({ ...policy, captureAfterMinutes: value as number }),
      /Capture after must be a whole number/,
    );
  }
});

test("the capture window extends the booking by the policy's bounds", () => {
  assert.deepEqual(captureWindow(booking, policy), {
    from: "2026-03-02T13:00:00.000Z",
    through: "2026-03-02T23:00:00.000Z",
  });
});
