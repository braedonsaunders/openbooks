import assert from "node:assert/strict";
import test from "node:test";
import { advanceAnchoredMonth, lastDayOfMonth } from "./cadence.ts";

test("anchored advance pins month-end starts instead of drifting", () => {
  assert.equal(advanceAnchoredMonth(2026, 1, 1, 31), "2026-02-28");
  // The step takes its day from the anchor, not the clamped date: Feb 28
  // reached from Jan 31 still steps to Mar 31, never Mar 28.
  assert.equal(advanceAnchoredMonth(2026, 2, 1, 31), "2026-03-31");
  assert.equal(advanceAnchoredMonth(2026, 3, 1, 31), "2026-04-30");
  assert.equal(advanceAnchoredMonth(2026, 1, 1, 15), "2026-02-15");
});

test("anchored advance handles leap years, quarters and multi-steps", () => {
  assert.equal(advanceAnchoredMonth(2028, 1, 1, 31), "2028-02-29");
  assert.equal(advanceAnchoredMonth(2028, 2, 1, 29), "2028-03-29");
  assert.equal(advanceAnchoredMonth(2026, 11, 3, 30), "2027-02-28");
  assert.equal(advanceAnchoredMonth(2026, 7, 12, 21), "2027-07-21");
  assert.equal(advanceAnchoredMonth(2026, 12, 1, 10), "2027-01-10");
  assert.equal(advanceAnchoredMonth(2026, 1, 3, 10), "2026-04-10");
});

test("anchored advance refuses invalid anchors and out-of-range years", () => {
  for (const anchor of [0, 32, -5, 1.5, Number.NaN]) {
    assert.throws(() => advanceAnchoredMonth(2026, 1, 1, anchor), /anchor day/);
  }
  assert.throws(() => advanceAnchoredMonth(2026, 0, 1, 10), /calendar month/);
  assert.throws(() => advanceAnchoredMonth(2026, 1, 0, 10), /positive integer/);
  assert.throws(() => advanceAnchoredMonth(9999, 12, 1, 10), /supported date range/);
  assert.equal(advanceAnchoredMonth(1, 1, 1, 15), "0001-02-15");
});

test("lastDayOfMonth follows the proleptic calendar", () => {
  assert.equal(lastDayOfMonth(2026, 2), 28);
  assert.equal(lastDayOfMonth(2028, 2), 29);
  assert.equal(lastDayOfMonth(2026, 4), 30);
  assert.equal(lastDayOfMonth(2026, 1), 31);
});
