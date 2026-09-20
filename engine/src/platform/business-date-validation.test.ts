import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarDays, addCalendarMonthsStart, calendarQuarterBounds, mondayOfIsoWeek, parseIsoDate, startOfMonth, weekStartsEndingOn } from "./business-date.ts";

test("business calendar helpers refuse impossible or incomplete source dates", () => {
  for (const value of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01", "0000-01-01", "not-a-date"]) {
    for (const operation of [parseIsoDate, startOfMonth, calendarQuarterBounds, mondayOfIsoWeek]) {
      assert.throws(() => operation(value), `${operation.name}: ${value}`);
    }
  }
});

test("business calendar arithmetic preserves years below 100 and Gregorian leap rules", () => {
  assert.equal(parseIsoDate("0001-01-01").toISOString(), "0001-01-01T00:00:00.000Z");
  assert.equal(addCalendarDays("0099-12-31", 1), "0100-01-01");
  assert.equal(addCalendarDays("0040-02-28", 1), "0040-02-29");
  assert.equal(addCalendarMonthsStart("0001-02-15", -1), "0001-01-01");
  assert.deepEqual(calendarQuarterBounds("0001-02-15"), { start: "0001-01-01", end: "0001-03-31" });
});

test("calendar offsets and week counts are whole numbers", () => {
  for (const offset of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => addCalendarDays("2026-01-15", offset));
    assert.throws(() => addCalendarMonthsStart("2026-01-15", offset));
    assert.throws(() => weekStartsEndingOn("2026-01-15", offset));
  }
  assert.throws(() => weekStartsEndingOn("2026-01-15", -1));
  assert.deepEqual(weekStartsEndingOn("2026-01-15", 0), []);
});

test("calendar arithmetic refuses dates outside the persisted calendar", () => {
  assert.throws(() => addCalendarDays("9999-12-31", 1));
  assert.throws(() => addCalendarDays("0001-01-01", -1));
  assert.throws(() => addCalendarMonthsStart("9999-12-31", 1));
  assert.throws(() => addCalendarMonthsStart("0001-01-01", -1));
  assert.deepEqual(calendarQuarterBounds("9999-12-31"), { start: "9999-10-01", end: "9999-12-31" });
});
