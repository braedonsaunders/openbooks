import assert from "node:assert/strict";
import test from "node:test";
import { outsideDeadlineWindow } from "./run-automation.ts";

test("a deadline window crossing 0099/0100 measures 13 days, not a negative span", () => {
  // The local calendarDaysBetween used Date.UTC, which maps years 0-99 onto
  // 1900-1999: 0099-12-25..0100-01-07 read as ~-694,000 days, so a rule with
  // withinDays 12 never fired across the century boundary.
  assert.equal(outsideDeadlineWindow("0099-12-25", "0100-01-07", 30), false);
  assert.equal(outsideDeadlineWindow("0099-12-25", "0100-01-07", 12), true);
  assert.equal(outsideDeadlineWindow("0100-01-07", "0100-01-07", 0), false);
});

test("deadline windows behave the same on either side of the century", () => {
  assert.equal(outsideDeadlineWindow("2026-08-01", "2026-08-14", 12), true);
  assert.equal(outsideDeadlineWindow("2026-08-01", "2026-08-14", 13), false);
  assert.equal(outsideDeadlineWindow("0099-12-25", "0100-01-07", 13), false);
});
