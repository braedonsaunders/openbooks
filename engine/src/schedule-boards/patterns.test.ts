import assert from "node:assert/strict";
import test from "node:test";
import {
  cycleDayOn,
  normalizePattern,
  occurrenceKey,
  patternOccurrences,
  type OccurrenceException,
  type PatternDefinition,
  type PatternSlot,
} from "./patterns.ts";

const day: PatternSlot = {
  position: 0,
  starts: "09:00",
  ends: "17:00",
  breakMinutes: 30,
  qualificationTypeIds: [],
};
const weekdays: PatternDefinition = {
  timeZone: "America/Toronto",
  cycleDays: 7,
  cycleAnchor: "2026-03-02",
  slots: [0, 1, 2, 3, 4].map((position) => ({ ...day, position })),
};

test("weekly slots keep their local clock times across daylight-saving changes", () => {
  const { occurrences, problems } = patternOccurrences({
    pattern: weekdays,
    from: "2026-03-06",
    through: "2026-03-09",
  });
  assert.deepEqual(problems, []);
  // Friday before and Monday after the 8 March change: 09:00 local is 14:00Z, then 13:00Z.
  assert.deepEqual(
    occurrences.map((o) => [o.occursOn, o.startsAt, o.endsAt]),
    [
      ["2026-03-06", "2026-03-06T14:00:00.000Z", "2026-03-06T22:00:00.000Z"],
      ["2026-03-09", "2026-03-09T13:00:00.000Z", "2026-03-09T21:00:00.000Z"],
    ],
  );
  assert.ok(occurrences.every((o) => o.breakMinutes === 30 && o.timeZone === "America/Toronto"));
});

test("an overnight slot spanning the autumn change works its real elapsed hours", () => {
  const overnight: PatternDefinition = {
    timeZone: "America/Toronto",
    cycleDays: 1,
    cycleAnchor: "2026-10-31",
    slots: [
      { position: 0, starts: "22:00", ends: "06:00", breakMinutes: 0, qualificationTypeIds: [] },
    ],
  };
  const { occurrences, problems } = patternOccurrences({
    pattern: overnight,
    from: "2026-10-31",
    through: "2026-10-31",
  });
  assert.deepEqual(problems, []);
  const [shift] = occurrences;
  assert.equal(shift!.startsOn, "2026-10-31");
  assert.equal(shift!.endsOn, "2026-11-01");
  assert.equal(
    (Date.parse(shift!.endsAt) - Date.parse(shift!.startsAt)) / 3600000,
    9,
    "the repeated hour is worked, not skipped",
  );
});

test("missing and repeated clock times are reported until omitted or selected", () => {
  const early: PatternDefinition = {
    timeZone: "America/Toronto",
    cycleDays: 1,
    cycleAnchor: "2026-01-01",
    slots: [
      { position: 0, starts: "01:30", ends: "04:00", breakMinutes: 0, qualificationTypeIds: [] },
    ],
  };
  const repeated = patternOccurrences({
    pattern: early,
    from: "2026-11-01",
    through: "2026-11-01",
  });
  assert.equal(repeated.occurrences.length, 0);
  assert.equal(repeated.problems[0]!.code, "schedule_pattern_repeated_time");
  assert.equal(repeated.problems[0]!.startChoices.length, 2);
  const select: OccurrenceException = {
    kind: "select_instant",
    startsAt: repeated.problems[0]!.startChoices[0]!.instant,
    endsAt: repeated.problems[0]!.endChoices[0]!.instant,
  };
  const selected = patternOccurrences({
    pattern: early,
    from: "2026-11-01",
    through: "2026-11-01",
    exceptions: new Map([[occurrenceKey("2026-11-01", 0), select]]),
  });
  assert.deepEqual(selected.problems, []);
  assert.equal(selected.occurrences[0]!.startsAt, "2026-11-01T05:30:00.000Z");
  const wrong: OccurrenceException = {
    kind: "select_instant",
    startsAt: "2026-11-01T07:30:00.000Z",
    endsAt: select.endsAt,
  };
  assert.equal(
    patternOccurrences({
      pattern: early,
      from: "2026-11-01",
      through: "2026-11-01",
      exceptions: new Map([[occurrenceKey("2026-11-01", 0), wrong]]),
    }).problems[0]!.code,
    "schedule_pattern_selection_mismatch",
  );
  const gap = patternOccurrences({
    pattern: { ...early, slots: [{ ...early.slots[0]!, starts: "02:30" }] },
    from: "2026-03-08",
    through: "2026-03-08",
  });
  assert.equal(gap.problems[0]!.code, "schedule_pattern_missing_time");
  const omitted = patternOccurrences({
    pattern: early,
    from: "2026-11-01",
    through: "2026-11-01",
    exceptions: new Map([
      [occurrenceKey("2026-11-01", 0), { kind: "omit", reason: "Site closed" }],
    ]),
  });
  assert.deepEqual(
    [omitted.occurrences.length, omitted.problems.length, omitted.omitted.length],
    [0, 0, 1],
  );
});

test("cycles continue across month, year and leap-day boundaries from their anchor", () => {
  const fortnight: PatternDefinition = {
    timeZone: "UTC",
    cycleDays: 14,
    cycleAnchor: "2027-12-20",
    slots: [
      { ...day, position: 0 },
      { ...day, position: 10 },
    ],
  };
  const { occurrences } = patternOccurrences({
    pattern: fortnight,
    from: "2027-12-25",
    through: "2028-03-05",
  });
  assert.deepEqual(
    occurrences.map((o) => o.occursOn),
    [
      "2027-12-30",
      "2028-01-03",
      "2028-01-13",
      "2028-01-17",
      "2028-01-27",
      "2028-01-31",
      "2028-02-10",
      "2028-02-14",
      "2028-02-24",
      "2028-02-28",
    ],
  );
  assert.equal(cycleDayOn(fortnight, "2028-02-29"), 1);
  assert.equal(
    cycleDayOn(fortnight, "2027-12-19"),
    13,
    "dates before the anchor fall on the same cycle",
  );
  const midnight = patternOccurrences({
    pattern: {
      timeZone: "UTC",
      cycleDays: 1,
      cycleAnchor: "2027-12-31",
      slots: [
        { position: 0, starts: "16:00", ends: "00:00", breakMinutes: 30, qualificationTypeIds: [] },
      ],
    },
    from: "2027-12-31",
    through: "2027-12-31",
  });
  assert.deepEqual(
    [midnight.occurrences[0]!.endsOn, midnight.occurrences[0]!.endsAt],
    ["2028-01-01", "2028-01-01T00:00:00.000Z"],
  );
});

test("definitions refuse overlap across the cycle boundary, empty work and duplicate requirements", () => {
  const sunday = { ...day, position: 6, starts: "23:00", ends: "10:00" };
  assert.throws(
    () => normalizePattern({ ...weekdays, slots: [day, sunday] }),
    /overlap.*end of the cycle/,
  );
  assert.throws(
    () => normalizePattern({ ...weekdays, slots: [{ ...day, breakMinutes: 480 }] }),
    /whole number from 0 through 240/,
  );
  assert.throws(
    () =>
      normalizePattern({
        ...weekdays,
        slots: [{ ...day, starts: "09:00", ends: "09:30", breakMinutes: 30 }],
      }),
    /no working time/,
  );
  assert.throws(
    () => normalizePattern({ ...weekdays, slots: [{ ...day, position: 7 }] }),
    /cycle day must be a whole number from 0 through 6/,
  );
  const type = "10000000-0000-4000-8000-000000000001";
  assert.throws(
    () =>
      normalizePattern({
        ...weekdays,
        slots: [{ ...day, qualificationTypeIds: [type, type.toUpperCase()] }],
      }),
    /appears twice/,
  );
  assert.throws(
    () => normalizePattern({ ...weekdays, timeZone: "Mars/Olympus" }),
    /time zone is unknown/,
  );
  assert.throws(
    () => patternOccurrences({ pattern: weekdays, from: "2026-01-01", through: "2027-01-02" }),
    /at most 366 days/,
  );
  const sorted = normalizePattern({
    ...weekdays,
    slots: [
      { ...day, position: 3 },
      { ...day, position: 1, qualificationTypeIds: [type.toUpperCase()] },
    ],
  });
  assert.deepEqual(
    sorted.slots.map((slot) => [slot.position, slot.qualificationTypeIds]),
    [
      [1, [type]],
      [3, []],
    ],
  );
});
