import assert from "node:assert/strict";
import test from "node:test";
import { isIsoCalendarDate } from "./iso-date.ts";

/** The calendar as the platform date library defines it. */
function platformAccepts(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() >= 1 &&
    date.toISOString().slice(0, 10) === value
  );
}

test("calendar dates agree with the platform calendar across leap rules and month ends", () => {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  for (const year of [0, 1, 4, 99, 100, 400, 1900, 1999, 2000, 2023, 2024, 2100, 2400, 9999]) {
    for (let month = 0; month <= 13; month++) {
      for (let day = 0; day <= 32; day++) {
        const value = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
        assert.equal(isIsoCalendarDate(value), platformAccepts(value), value);
      }
    }
  }
});

test("only the exact YYYY-MM-DD form of a string is a calendar date", () => {
  for (const value of ["2024-02-29", "0001-01-01", "9999-12-31"])
    assert.equal(isIsoCalendarDate(value), true, value);
  for (const value of [
    "2023-02-29",
    "0000-01-01",
    "2024-2-01",
    "2024-02-01T00:00:00Z",
    " 2024-02-01",
    "20240201",
    "+2024-02-01",
    "2024-02-01\n",
  ]) {
    assert.equal(isIsoCalendarDate(value), false, JSON.stringify(value));
  }
  for (const value of [null, undefined, 20240201, new Date("2024-02-01"), {}])
    assert.equal(isIsoCalendarDate(value), false);
});
