import assert from "node:assert/strict";
import { test } from "node:test";
import { toUnits } from "./money.ts";
import {
  allocateByRelativeSSP,
  apportion,
  computeRecognitionSchedule,
  fairValueRangeFlag,
  type RecognitionInput,
} from "./revenue-recognition.ts";

/** Sum of the planned amounts on a plan, in integer money units. */
function plannedUnits(plan: { planned: string }[]): bigint {
  return plan.reduce((acc, l) => acc + toUnits(l.planned), 0n);
}

// ---------------------------------------------------------------------------
// apportion — exact, proportional, drift-free
// ---------------------------------------------------------------------------

test("apportion sums exactly to the total", () => {
  const parts = apportion(toUnits("1000"), [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), toUnits("1000"));
  // 1000/3 → 333.3334 + 333.3333 + 333.3333, largest remainder to the first
  assert.deepEqual(parts.map(String), [toUnits("333.3334"), toUnits("333.3333"), toUnits("333.3333")].map(String));
});

test("apportion is proportional to weights", () => {
  const parts = apportion(toUnits("1000"), [3, 1]);
  assert.deepEqual(parts, [toUnits("750"), toUnits("250")]);
});

test("apportion handles negative totals and preserves the exact sum", () => {
  const parts = apportion(toUnits("-1000"), [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), toUnits("-1000"));
});

test("apportion returns zeros for zero total or non-positive weights", () => {
  assert.deepEqual(apportion(0n, [1, 2, 3]), [0n, 0n, 0n]);
  assert.deepEqual(apportion(toUnits("100"), [0, 0]), [0n, 0n]);
});

// ---------------------------------------------------------------------------
// allocateByRelativeSSP — ASC 606 relative standalone-selling-price
// ---------------------------------------------------------------------------

test("relative-SSP allocation splits the price by SSP and sums exactly", () => {
  const alloc = allocateByRelativeSSP("1000", [{ ssp: "600" }, { ssp: "400" }]);
  assert.deepEqual(alloc, ["600.0000", "400.0000"]);
});

test("relative-SSP allocation absorbs rounding so the bundle still sums to the price", () => {
  const alloc = allocateByRelativeSSP("1000", [{ ssp: "100" }, { ssp: "100" }, { ssp: "100" }]);
  assert.equal(alloc.reduce((a, s) => a + toUnits(s), 0n), toUnits("1000"));
});

test("relative-SSP allocation falls back to the booked amount when SSP is missing", () => {
  const alloc = allocateByRelativeSSP("1000", [{ ssp: null, booked: "500" }, { ssp: "500" }]);
  assert.deepEqual(alloc, ["500.0000", "500.0000"]);
});

// ---------------------------------------------------------------------------
// fairValueRangeFlag — allocated per-unit price vs fair value [low, high]
// ---------------------------------------------------------------------------

test("fair value range: in-range and boundary per-unit prices never flag", () => {
  assert.equal(fairValueRangeFlag("110.0000", "1", "100.0000", "120.0000"), null);
  assert.equal(fairValueRangeFlag("100.0000", "1", "100.0000", "120.0000"), null);
  assert.equal(fairValueRangeFlag("120.0000", "1", "100.0000", "120.0000"), null);
  // 3 units at 110/unit against a 100–120 range.
  assert.equal(fairValueRangeFlag("330.0000", "3", "100.0000", "120.0000"), null);
});

test("fair value range: out-of-range per-unit prices flag below/above", () => {
  assert.equal(fairValueRangeFlag("99.9900", "1", "100.0000", "120.0000"), "below_range");
  assert.equal(fairValueRangeFlag("120.0100", "1", "100.0000", "120.0000"), "above_range");
  // 4 units, line total 360 → 90/unit, under the 100 floor.
  assert.equal(fairValueRangeFlag("360.0000", "4", "100.0000", "120.0000"), "below_range");
});

test("fair value range: open-ended and missing bounds", () => {
  assert.equal(fairValueRangeFlag("50.0000", "1", null, null), null);
  assert.equal(fairValueRangeFlag("50.0000", "1", "100.0000", null), "below_range");
  assert.equal(fairValueRangeFlag("500.0000", "1", null, "120.0000"), "above_range");
  assert.equal(fairValueRangeFlag("500.0000", "1", "100.0000", null), null);
});

test("fair value range: zero/missing quantity falls back to the line amount", () => {
  assert.equal(fairValueRangeFlag("110.0000", "0", "100.0000", "120.0000"), null);
  assert.equal(fairValueRangeFlag("110.0000", null, "100.0000", "120.0000"), null);
  assert.equal(fairValueRangeFlag("90.0000", null, "100.0000", "120.0000"), "below_range");
});

// ---------------------------------------------------------------------------
// computeRecognitionSchedule — per method
// ---------------------------------------------------------------------------

test("point_in_time recognizes the whole amount in the start month", () => {
  const plan = computeRecognitionSchedule({ total: "1200", method: "point_in_time", startOn: "2026-03-10" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].periodMonth, "2026-03-01");
  assert.equal(toUnits(plan[0].planned), toUnits("1200"));
});

test("straight_line_even spreads evenly over the term and sums exactly", () => {
  const plan = computeRecognitionSchedule({
    total: "1200",
    method: "straight_line_even",
    startOn: "2026-01-01",
    termPeriods: 12,
  });
  assert.equal(plan.length, 12);
  assert.equal(plan[0].periodMonth, "2026-01-01");
  assert.equal(plan[11].periodMonth, "2026-12-01");
  for (const l of plan) assert.equal(toUnits(l.planned), toUnits("100"));
  assert.equal(plannedUnits(plan), toUnits("1200"));
});

test("initial amount percent is recognized up front, remainder spread evenly", () => {
  const plan = computeRecognitionSchedule({
    total: "1200",
    method: "straight_line_even",
    startOn: "2026-01-01",
    termPeriods: 12,
    initialAmountPercent: "10",
  });
  // 10% = 120 up front; remainder 1080 / 12 = 90; first period = 210, rest = 90.
  assert.equal(toUnits(plan[0].planned), toUnits("210"));
  assert.equal(toUnits(plan[1].planned), toUnits("90"));
  assert.equal(plannedUnits(plan), toUnits("1200"));
});

test("straight_line_prorate_first_last weights the first and last partial months by days", () => {
  const plan = computeRecognitionSchedule({
    total: "3100",
    method: "straight_line_prorate_first_last",
    startOn: "2026-01-15",
    endOn: "2026-02-14",
  });
  assert.equal(plan.length, 2);
  // Jan: 15..31 = 17 days; Feb: 1..14 = 14 days; weights [17,14] of 3100.
  assert.equal(plannedUnits(plan), toUnits("3100"));
  assert.ok(toUnits(plan[0].planned) > toUnits(plan[1].planned));
});

test("straight_line_daily allocates by exact days in each month and sums exactly", () => {
  const plan = computeRecognitionSchedule({
    total: "9000",
    method: "straight_line_daily",
    startOn: "2026-01-01",
    endOn: "2026-03-31",
  });
  assert.equal(plan.length, 3);
  // 90 days total: Jan 31, Feb 28, Mar 31 → 3100, 2800, 3100.
  assert.equal(toUnits(plan[0].planned), toUnits("3100"));
  assert.equal(toUnits(plan[1].planned), toUnits("2800"));
  assert.equal(toUnits(plan[2].planned), toUnits("3100"));
  assert.equal(plannedUnits(plan), toUnits("9000"));
});

test("percent_complete recognizes the cumulative target minus already-recognized", () => {
  const base: RecognitionInput = {
    total: "1000",
    method: "percent_complete",
    startOn: "2026-06-01",
    percentComplete: "40",
    alreadyRecognized: "250",
  };
  const plan = computeRecognitionSchedule(base);
  assert.equal(plan.length, 1);
  assert.equal(toUnits(plan[0].planned), toUnits("150")); // 40% of 1000 = 400; 400 − 250
});

test("percent_complete never claws back when already-recognized exceeds the target", () => {
  const plan = computeRecognitionSchedule({
    total: "1000",
    method: "percent_complete",
    startOn: "2026-06-01",
    percentComplete: "40",
    alreadyRecognized: "500",
  });
  assert.equal(toUnits(plan[0].planned), 0n);
});

test("milestone recognizes exactly the entered event amounts", () => {
  const plan = computeRecognitionSchedule({
    total: "5000",
    method: "milestone",
    startOn: "2026-01-01",
    events: [
      { periodMonth: "2026-02-01", amount: "2000" },
      { periodMonth: "2026-05-01", amount: "3000" },
    ],
  });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].periodMonth, "2026-02-01");
  assert.equal(plannedUnits(plan), toUnits("5000"));
});

test("period offset defers the whole schedule by N months", () => {
  const plan = computeRecognitionSchedule({
    total: "1200",
    method: "straight_line_even",
    startOn: "2026-01-01",
    termPeriods: 12,
    periodOffset: 2,
  });
  assert.equal(plan[0].periodMonth, "2026-03-01");
  assert.equal(plan[11].periodMonth, "2027-02-01");
  assert.equal(plannedUnits(plan), toUnits("1200"));
});

test("start offset days pushes the recognition start into the next month when it crosses a boundary", () => {
  const plan = computeRecognitionSchedule({
    total: "1000",
    method: "straight_line_even",
    startOn: "2026-01-20",
    termPeriods: 1,
    startOffsetDays: 15, // 2026-01-20 + 15 = 2026-02-04
  });
  assert.equal(plan[0].periodMonth, "2026-02-01");
});

test("cumulative column tracks recognized-to-date and ends at the total", () => {
  const plan = computeRecognitionSchedule({
    total: "1200",
    method: "straight_line_even",
    startOn: "2026-01-01",
    termPeriods: 12,
  });
  assert.equal(toUnits(plan[0].cumulative), toUnits("100"));
  assert.equal(toUnits(plan[11].cumulative), toUnits("1200"));
});
