import assert from "node:assert/strict";
import test from "node:test";
import { consolidationPeriodFor } from "./consolidated-billing.ts";

test("monthly buckets run cut-off to cut-off", () => {
  const group = { cadence: "monthly" as const, cutoffDay: 3 };
  assert.deepEqual(consolidationPeriodFor(group, "2026-07-15"), {
    periodStart: "2026-07-03",
    periodEnd: "2026-08-02",
  });
  assert.deepEqual(consolidationPeriodFor(group, "2026-07-02"), {
    periodStart: "2026-06-03",
    periodEnd: "2026-07-02",
  });
});

test("monthly buckets roll over year ends", () => {
  const group = { cadence: "monthly" as const, cutoffDay: 1 };
  assert.deepEqual(consolidationPeriodFor(group, "2026-12-31"), {
    periodStart: "2026-12-01",
    periodEnd: "2026-12-31",
  });
  assert.deepEqual(consolidationPeriodFor(group, "2027-01-01"), {
    periodStart: "2027-01-01",
    periodEnd: "2027-01-31",
  });
});

test("weekly buckets are the seven days starting on the cut-off weekday", () => {
  const group = { cadence: "weekly" as const, cutoffDay: 7 };
  assert.deepEqual(consolidationPeriodFor(group, "2026-07-15"), {
    periodStart: "2026-07-12",
    periodEnd: "2026-07-18",
  });
});

test("an unplaceable date refuses instead of guessing a bucket", () => {
  assert.throws(
    () => consolidationPeriodFor({ cadence: "monthly", cutoffDay: 1 }, "2026-02-30"),
    /valid ISO date/,
  );
});
