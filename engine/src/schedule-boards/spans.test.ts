import assert from "node:assert/strict";
import test from "node:test";
import { ScheduleError } from "./errors.ts";
import { datesBetween, daySpan, timedSpan, windowStart, workedMinutes } from "./spans.ts";

const day = { timeZone: "America/Toronto", dayStarts: "07:00", dayEnds: "15:30", dayBreakMinutes: 30 };

test("a whole-day booking takes the board's working day in its time zone, across a clock change", () => {
  const summer = daySpan(day, "2026-10-30");
  assert.equal(summer.startsAt, "2026-10-30T11:00:00.000Z");
  assert.equal(summer.endsAt, "2026-10-30T19:30:00.000Z");
  const winter = daySpan(day, "2026-11-02");
  assert.equal(winter.startsAt, "2026-11-02T12:00:00.000Z");
  assert.equal(workedMinutes(winter.startsAt, winter.endsAt, winter.breakMinutes), 480);
});

test("a timed booking ending at or before its start runs overnight into the next day", () => {
  const night = timedSpan({ onDate: "2026-10-12", starts: "22:00", ends: "06:00", breakMinutes: 30, timeZone: "America/Toronto" });
  assert.equal(night.startsOn, "2026-10-12");
  assert.equal(night.endsOn, "2026-10-13");
  assert.equal(workedMinutes(night.startsAt, night.endsAt, night.breakMinutes), 450);
  // The night the clocks fall back is an hour longer; minutes follow the instants, not the wall clock.
  const fallBack = timedSpan({ onDate: "2026-10-31", starts: "22:00", ends: "06:00", breakMinutes: 0, timeZone: "America/Toronto" });
  assert.equal(workedMinutes(fallBack.startsAt, fallBack.endsAt, 0), 540);
});

test("clock times that do not exist or happen twice are refused rather than guessed", () => {
  assert.throws(() => timedSpan({ onDate: "2026-03-08", starts: "02:30", ends: "08:00", breakMinutes: 0, timeZone: "America/Toronto" }),
    (error: unknown) => error instanceof ScheduleError && error.code === "schedule_clock_change");
  assert.throws(() => timedSpan({ onDate: "2026-11-01", starts: "01:30", ends: "08:00", breakMinutes: 0, timeZone: "America/Toronto" }),
    (error: unknown) => error instanceof ScheduleError && error.code === "schedule_clock_change");
});

test("a break must leave working time and the zone must be a named zone", () => {
  assert.throws(() => timedSpan({ onDate: "2026-10-12", starts: "09:00", ends: "10:00", breakMinutes: 60, timeZone: "America/Toronto" }), ScheduleError);
  assert.throws(() => timedSpan({ onDate: "2026-10-12", starts: "09:00", ends: "10:00", breakMinutes: 0, timeZone: "Mars/Olympus" }), ScheduleError);
  assert.throws(() => timedSpan({ onDate: "2026-10-12", starts: "9:00", ends: "10:00", breakMinutes: 0, timeZone: "America/Toronto" }), ScheduleError);
});

test("ranges of a week or more start on the board's week start; shorter ranges start on the date", () => {
  assert.equal(windowStart("2026-10-14", 14, 0), "2026-10-11");
  assert.equal(windowStart("2026-10-14", 7, 1), "2026-10-12");
  assert.equal(windowStart("2026-10-14", 3, 0), "2026-10-14");
  assert.deepEqual(datesBetween("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.throws(() => datesBetween("2026-10-01", "2026-12-31"), ScheduleError);
});
