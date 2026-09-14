import assert from "node:assert/strict";
import test from "node:test";
import { parseCycleDays } from "./work-schedule-days.ts";

/**
 * Work-schedule day parsing — a schedule decides holiday pay, so a payload
 * row the server cannot place must refuse the save, never vanish into an
 * ok:true response with fewer days than the author entered.
 */

test("a full week of days parses to day rows", () => {
  const parsed = parseCycleDays(
    [
      { dayIndex: 0, hours: "8" },
      { dayIndex: 1, hours: "8" },
      { dayIndex: 2, hours: "8" },
      { dayIndex: 3, hours: "8" },
      { dayIndex: 4, hours: "8" },
    ],
    7,
  );
  assert.deepEqual(parsed.days, [
    { dayIndex: 0, hours: "8.0000" },
    { dayIndex: 1, hours: "8.0000" },
    { dayIndex: 2, hours: "8.0000" },
    { dayIndex: 3, hours: "8.0000" },
    { dayIndex: 4, hours: "8.0000" },
  ]);
});

test("zero-hour days stay omitted without failing the save", () => {
  const parsed = parseCycleDays(
    [
      { dayIndex: 0, hours: "8" },
      { dayIndex: 6, hours: "0" },
    ],
    7,
  );
  assert.deepEqual(parsed.days, [{ dayIndex: 0, hours: "8.0000" }]);
});

test("a day outside the cycle refuses instead of silently dropping", () => {
  // A 14-day pattern saved back as 7 days (or a crafted payload) must not
  // read back ok:true with the second week's hours gone.
  assert.throws(() => parseCycleDays([{ dayIndex: 9, hours: "8" }], 7), /outside this 7-day cycle/);
  assert.throws(() => parseCycleDays([{ dayIndex: -1, hours: "8" }], 7), /outside this 7-day cycle/);
  assert.throws(() => parseCycleDays([{ dayIndex: 1.5, hours: "8" }], 7), /outside this 7-day cycle/);
});

test("a malformed day row refuses instead of silently dropping", () => {
  assert.throws(() => parseCycleDays([null], 7), /must name its day index and hours/);
  assert.throws(() => parseCycleDays(["monday"], 7), /must name its day index and hours/);
  assert.throws(() => parseCycleDays([{}], 7), /must name its day index and hours/);
  assert.throws(() => parseCycleDays([{ hours: "8" }], 7), /must name its day index and hours/);
  assert.throws(() => parseCycleDays([{ dayIndex: null, hours: "8" }], 7), /must name its day index and hours/);
  assert.throws(() => parseCycleDays([{ dayIndex: "", hours: "8" }], 7), /must name its day index and hours/);
});

test("a repeated day refuses instead of violating the position index", () => {
  assert.throws(
    () =>
      parseCycleDays(
        [
          { dayIndex: 0, hours: "8" },
          { dayIndex: 0, hours: "4" },
        ],
        7,
      ),
    /more than once/,
  );
});

test("non-numeric and out-of-range hours still refuse", () => {
  assert.throws(() => parseCycleDays([{ dayIndex: 0, hours: "all day" }], 7), /not a number of hours/);
  assert.throws(() => parseCycleDays([{ dayIndex: 0, hours: "25" }], 7), /between 0 and 24 hours/);
  assert.throws(() => parseCycleDays([{ dayIndex: 0, hours: "-1" }], 7), /between 0 and 24 hours/);
});
