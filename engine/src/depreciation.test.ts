import assert from "node:assert/strict";
import test from "node:test";
import { computeSchedule, type DepreciationMethod, type ScheduleInput } from "./depreciation.ts";
import { add, toUnits } from "./money.ts";

const base = (over: Partial<ScheduleInput>): ScheduleInput => ({
  cost: "12000.0000",
  salvage: "0.0000",
  inServiceOn: "2026-01-15",
  lifeMonths: 12,
  method: "straight_line",
  ...over,
});

/** Total depreciation must equal cost − salvage EXACTLY, accumulated must be
 *  monotonic, and NBV must land exactly on salvage — for every method. */
function assertInvariants(input: ScheduleInput) {
  const plan = computeSchedule(input);
  const totalMinorTarget = toUnits(input.cost) - toUnits(input.salvage);
  let sum = "0";
  let prevAcc = -1n;
  for (const line of plan) {
    sum = add(sum, line.planned);
    assert.ok(toUnits(line.planned) >= 0n, `no negative depreciation (${line.periodMonth})`);
    assert.ok(toUnits(line.accumulated) >= prevAcc, "accumulated is non-decreasing");
    prevAcc = toUnits(line.accumulated);
  }
  assert.equal(toUnits(sum), totalMinorTarget, "lifetime depreciation = cost − salvage exactly");
  assert.equal(plan[plan.length - 1]!.netBookValue, input.salvage, "final NBV lands on salvage");
}

test("straight-line: even monthly amount, exact total", () => {
  const plan = computeSchedule(base({ cost: "12000.0000", salvage: "0.0000", lifeMonths: 12 }));
  assert.equal(plan.length, 12);
  assert.equal(plan[0]!.planned, "1000.0000");
  assert.equal(plan[0]!.periodMonth, "2026-01-01"); // in-service month, full month
  assertInvariants(base({ cost: "12000.0000", salvage: "0.0000", lifeMonths: 12 }));
});

test("straight-line with salvage + rounding remainder absorbed in the last month", () => {
  // (10000 − 1000)/7 = 1285.7142…; the final month plugs so the total is exact.
  const input = base({ cost: "10000.0000", salvage: "1000.0000", lifeMonths: 7 });
  const plan = computeSchedule(input);
  assert.equal(plan.length, 7);
  assertInvariants(input);
  assert.notEqual(plan[6]!.planned, plan[0]!.planned); // last month differs (the plug)
});

test("double-declining balance: front-loaded, converges exactly to salvage", () => {
  const input = base({ cost: "10000.0000", salvage: "0.0000", lifeMonths: 60, method: "double_declining" });
  const plan = computeSchedule(input);
  assert.ok(toUnits(plan[0]!.planned) > toUnits(plan[12]!.planned), "front-loaded");
  assertInvariants(input);
});

test("declining-balance honors an explicit annual rate", () => {
  const slow = computeSchedule(base({ cost: "10000.0000", lifeMonths: 60, method: "declining_balance", ratePercent: "20" }));
  const fast = computeSchedule(base({ cost: "10000.0000", lifeMonths: 60, method: "declining_balance", ratePercent: "40" }));
  assert.ok(toUnits(fast[0]!.planned) > toUnits(slow[0]!.planned), "higher rate depreciates faster");
  assertInvariants(base({ cost: "10000.0000", lifeMonths: 60, method: "declining_balance", ratePercent: "30" }));
});

test("a fully-salvaged asset (salvage ≥ cost) has an empty schedule", () => {
  assert.deepEqual(computeSchedule(base({ cost: "5000.0000", salvage: "5000.0000" })), []);
});

test("invariants hold across every implemented method", () => {
  for (const method of ["straight_line", "declining_balance", "double_declining", "manual"] as DepreciationMethod[]) {
    assertInvariants(base({ cost: "8000.0000", salvage: "500.0000", lifeMonths: 36, method, ratePercent: "25" }));
  }
});

// units_of_production needs per-period usage that the per-asset BOOK path does
// not capture yet, so in this path it falls back to straight-line (a sensible,
// non-zero schedule) rather than the old silent declining-balance fall-through.
// The formula engine (depreciation-formula.ts) computes true units-of-production
// when usage is supplied — see its tests.
test("units_of_production falls back to straight-line in the book path (until usage capture)", () => {
  const asUsage = base({ cost: "10000.0000", lifeMonths: 60, method: "units_of_production" });
  const asStraightLine = base({ cost: "10000.0000", lifeMonths: 60, method: "straight_line" });
  assert.deepEqual(computeSchedule(asUsage), computeSchedule(asStraightLine));
});
