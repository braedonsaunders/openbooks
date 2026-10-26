import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError } from "./errors.ts";
import {
  civilWeekday,
  parseRecurrence,
  recurrenceOccurrences,
  versionedOccurrences,
  MAX_OCCURRENCES,
} from "./recurrence.ts";

test("weekly visits fall on the chosen weekdays every N weeks from the anchor's week", () => {
  const rule = parseRecurrence({ repeat: "weekly", interval: 2, weekdays: [4, 1] });
  assert.deepEqual(rule.weekdays, [1, 4], "weekdays are normalized ascending");
  // 2026-03-02 is a Monday.
  assert.equal(civilWeekday("2026-03-02"), 1);
  assert.deepEqual(recurrenceOccurrences(rule, "2026-03-02", "2026-03-01", "2026-03-31"), [
    "2026-03-02",
    "2026-03-05",
    "2026-03-16",
    "2026-03-19",
    "2026-03-30",
  ]);
  // A window that starts mid-series yields only the occurrences inside it, on the same grid.
  assert.deepEqual(recurrenceOccurrences(rule, "2026-03-02", "2026-03-17", "2026-03-31"), [
    "2026-03-19",
    "2026-03-30",
  ]);
});

test("monthly visits keep the anchor day, clamping short months, or the nth weekday with a fifth falling back to the last", () => {
  const byDay = parseRecurrence({ repeat: "monthly", interval: 1 });
  assert.deepEqual(
    recurrenceOccurrences(byDay, "2026-01-31", "2026-01-01", "2026-04-30"),
    ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"],
    "each month steps from the anchor, so a clamped February does not shorten March",
  );
  const byWeekday = parseRecurrence({ repeat: "monthly", interval: 1, monthlyBy: "weekday" });
  // 2026-01-29 is the fifth Thursday of January; February 2026 has four Thursdays.
  assert.deepEqual(recurrenceOccurrences(byWeekday, "2026-01-29", "2026-01-01", "2026-04-30"), [
    "2026-01-29",
    "2026-02-26",
    "2026-03-26",
    "2026-04-30",
  ]);
  const quarterly = parseRecurrence({ repeat: "monthly", interval: 3 });
  assert.deepEqual(recurrenceOccurrences(quarterly, "2026-02-15", "2026-06-01", "2027-01-01"), [
    "2026-08-15",
    "2026-11-15",
  ]);
});

test("daily and yearly visits step exactly, including leap days, and never start before the anchor", () => {
  const daily = parseRecurrence({ repeat: "daily", interval: 3 });
  assert.deepEqual(recurrenceOccurrences(daily, "2026-03-10", "2026-03-01", "2026-03-20"), [
    "2026-03-10",
    "2026-03-13",
    "2026-03-16",
    "2026-03-19",
  ]);
  const yearly = parseRecurrence({ repeat: "yearly", interval: 1 });
  assert.deepEqual(recurrenceOccurrences(yearly, "2028-02-29", "2028-01-01", "2033-12-31"), [
    "2028-02-29",
    "2029-02-28",
    "2030-02-28",
    "2031-02-28",
    "2032-02-29",
    "2033-02-28",
  ]);
  assert.deepEqual(
    recurrenceOccurrences(daily, "2026-03-10", "2026-03-01", "2026-03-09"),
    [],
    "a window entirely before the anchor holds nothing",
  );
});

test("generation is deterministic and bounded", () => {
  const daily = parseRecurrence({ repeat: "daily", interval: 1 });
  const first = recurrenceOccurrences(daily, "2026-01-01", "2026-01-01", "2026-12-31");
  assert.deepEqual(
    recurrenceOccurrences(daily, "2026-01-01", "2026-01-01", "2026-12-31"),
    first,
    "the same inputs give the same dates",
  );
  assert.equal(first.length, 365);
  assert.equal(
    recurrenceOccurrences(daily, "2026-01-01", "2026-01-01", "2030-12-31").length,
    MAX_OCCURRENCES,
  );
});

test("effective-dated versions each govern their own dates and the agreement window bounds them", () => {
  const weekly = parseRecurrence({ repeat: "weekly", interval: 1 });
  const monthly = parseRecurrence({ repeat: "monthly", interval: 1 });
  const occurrences = versionedOccurrences(
    [
      { id: "v2", effectiveFrom: "2026-04-01", recurrence: monthly },
      { id: "v1", effectiveFrom: "2026-03-02", recurrence: weekly },
    ],
    { startsOn: "2026-03-02", endsOn: "2026-06-15" },
    "2026-03-01",
    "2026-12-31",
  );
  assert.deepEqual(occurrences, [
    { versionId: "v1", occursOn: "2026-03-02" },
    { versionId: "v1", occursOn: "2026-03-09" },
    { versionId: "v1", occursOn: "2026-03-16" },
    { versionId: "v1", occursOn: "2026-03-23" },
    { versionId: "v1", occursOn: "2026-03-30" },
    { versionId: "v2", occursOn: "2026-04-01" },
    { versionId: "v2", occursOn: "2026-05-01" },
    { versionId: "v2", occursOn: "2026-06-01" },
  ]);
});

test("invalid rules refuse by name", () => {
  for (const value of [
    null,
    { repeat: "hourly", interval: 1 },
    { repeat: "weekly", interval: 0 },
    { repeat: "weekly", interval: 1.5 },
    { repeat: "daily", interval: 1, weekdays: [1] },
    { repeat: "weekly", interval: 1, weekdays: [7] },
    { repeat: "weekly", interval: 1, monthlyBy: "day" },
    { repeat: "monthly", interval: 1, extra: true },
  ]) {
    assert.throws(
      () => parseRecurrence(value),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "service_invalid_recurrence",
    );
  }
});
