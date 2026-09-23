import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDaysBetween,
  civilDateFromParts,
  civilDayIndex,
  daysInCivilMonth,
  formatInZone,
  inclusiveCalendarDays,
  isoFromCivilDayIndex,
  parseIsoDate,
  utcDateFromParts,
} from "./business-date.ts";

/**
 * Civil-date arithmetic (the Date.UTC 0-99 → 1900-1999 remap class) plus the
 * formatInZone year-padding contract.
 *
 * Lives in the unit partition on purpose: engine/src/platform/business-date.test.ts
 * is database-owned (its businessToday/businessTimeZone cases need a database),
 * so pure civil-date coverage belongs here where it runs with no database.
 * Every case below pins a value the old `Date.UTC(year, ...)` idiom got wrong
 * for years 0001-0099.
 */

test("civilDayIndex keeps literal years 0001-0099 (no 1900 remap)", () => {
  // Adjacent civil days are adjacent indices at every supported boundary.
  assert.equal(civilDayIndex("0100-01-01") - civilDayIndex("0099-12-31"), 1);
  assert.equal(civilDayIndex("2000-01-01") - civilDayIndex("1999-12-31"), 1);
  assert.equal(civilDayIndex("0001-01-02") - civilDayIndex("0001-01-01"), 1);
  // The remapped reading would place 0099 eighteen centuries after 0100.
  assert.ok(civilDayIndex("0099-12-31") < civilDayIndex("0100-01-01"));
});

test("calendarDaysBetween and inclusiveCalendarDays cross 0099/0100", () => {
  // The payroll case: a period 0099-12-25..0100-01-07 spans 14 days, not -693946.
  assert.equal(calendarDaysBetween("0099-12-25", "0100-01-07"), 13);
  assert.equal(inclusiveCalendarDays("0099-12-25", "0100-01-07"), 14);
  assert.equal(inclusiveCalendarDays("0100-01-07", "0100-01-07"), 1);
  assert.equal(calendarDaysBetween("0100-01-07", "0099-12-25"), -13);
  assert.equal(calendarDaysBetween("2026-08-01", "2026-08-31"), 30);
  assert.equal(inclusiveCalendarDays("2026-08-01", "2026-08-31"), 31);
});

test("civil leap years: 0096 is leap, 0100 is not", () => {
  assert.equal(civilDayIndex("0096-02-29") - civilDayIndex("0096-02-28"), 1);
  assert.equal(civilDayIndex("0096-03-01") - civilDayIndex("0096-02-29"), 1);
  // 0100 has no February 29th: Feb 28 is followed by March 1st.
  assert.equal(calendarDaysBetween("0100-02-28", "0100-03-01"), 1);
  assert.throws(() => civilDayIndex("0100-02-29"), RangeError);
  assert.equal(daysInCivilMonth(96, 2), 29);
  assert.equal(daysInCivilMonth(100, 2), 28);
  assert.equal(daysInCivilMonth(2000, 2), 29);
  assert.equal(daysInCivilMonth(1900, 2), 28);
  assert.equal(daysInCivilMonth(2026, 2), 28);
  assert.equal(daysInCivilMonth(2026, 1), 31);
  assert.equal(daysInCivilMonth(96, 12), 31);
});

test("isoFromCivilDayIndex inverts civilDayIndex at the boundaries", () => {
  for (const iso of ["0001-01-01", "0096-02-29", "0099-12-31", "0100-01-01", "1999-12-31", "2000-01-01", "2026-08-21", "9999-12-31"]) {
    assert.equal(isoFromCivilDayIndex(civilDayIndex(iso)), iso);
  }
});

test("utcDateFromParts keeps the literal year and matches Date.UTC normalization", () => {
  const date = utcDateFromParts(96, 1, 29);
  assert.equal(date.getUTCFullYear(), 96);
  assert.equal(date.getUTCMonth(), 1);
  assert.equal(date.getUTCDate(), 29);
  // Day 0 is the previous month's last day — the idiom month-end call sites use.
  assert.equal(utcDateFromParts(2026, 2, 0).getUTCDate(), 28);
  assert.equal(utcDateFromParts(96, 2, 0).getUTCDate(), 29);
  // Month overflow rolls over, exactly like Date.UTC.
  assert.equal(utcDateFromParts(2026, 12, 1).toISOString().slice(0, 10), "2027-01-01");
  assert.throws(() => utcDateFromParts(Number.NaN, 0, 1), RangeError);
  assert.throws(() => utcDateFromParts(2026.5, 0, 1), RangeError);
});

test("utcDateFromParts carries out-of-range time into the date like Date.UTC", () => {
  // Date.UTC parity for years >= 100, where both spellings are exact.
  const cases: Array<[number, number, number, number, number, number, number]> = [
    [2026, 0, 1, 24, 0, 0, 0],
    [2026, 0, 1, -1, 0, 0, 0],
    [2026, 0, 1, 0, 1440, 0, 0],
    [2026, 0, 1, 0, 0, 0, 1500],
    [2026, 0, 1, 25, 61, 61, 1001],
    [2026, 11, 31, 24, 0, 0, 0],
  ];
  for (const [y, mo, d, h, mi, s, ms] of cases) {
    assert.equal(
      utcDateFromParts(y, mo, d, h, mi, s, ms).getTime(),
      Date.UTC(y, mo, d, h, mi, s, ms),
    );
  }
  // The same carries across the 0099/0100 boundary keep the literal year.
  assert.equal(
    utcDateFromParts(99, 11, 31, 24).toISOString().slice(0, 10),
    "0100-01-01",
  );
  assert.equal(
    utcDateFromParts(100, 0, 1, -1).toISOString().slice(0, 10),
    "0099-12-31",
  );
});

test("civilDateFromParts renders zero-padded YYYY-MM-DD", () => {
  assert.equal(civilDateFromParts(96, 2, 29), "0096-02-29");
  assert.equal(civilDateFromParts(1, 1, 1), "0001-01-01");
  assert.equal(civilDateFromParts(999, 12, 31), "0999-12-31");
  assert.equal(civilDateFromParts(2026, 8, 5), "2026-08-05");
});

test("formatInZone pads the year to 4 digits and round-trips through parseIsoDate", () => {
  for (const iso of ["0001-01-01", "0096-03-10", "0999-12-31", "1000-01-01", "2026-08-21"]) {
    const rendered = formatInZone(new Date(`${iso}T00:00:00Z`), "UTC");
    assert.equal(rendered, iso);
    assert.equal(parseIsoDate(rendered).toISOString().slice(0, 10), iso);
  }
});

test("civil helpers refuse garbage instead of indexing a neighbor", () => {
  assert.throws(() => civilDayIndex("not-a-date"), RangeError);
  assert.throws(() => civilDayIndex("2026-13-01"), RangeError);
  assert.throws(() => civilDayIndex("0096-02-30"), RangeError);
  assert.throws(() => calendarDaysBetween("2026-08-01", "2026-02-30"), RangeError);
  assert.throws(() => isoFromCivilDayIndex(Number.NaN), RangeError);
});
