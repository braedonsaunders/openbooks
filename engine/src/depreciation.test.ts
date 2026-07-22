import assert from "node:assert/strict";
import test from "node:test";
import { computeSchedule, computeUnitsOfProductionCharge, type DepreciationMethod, type ScheduleInput } from "./depreciation.ts";
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

test("invariants hold across every enabled built-in method", () => {
  for (const method of ["straight_line", "declining_balance", "double_declining"] as DepreciationMethod[]) {
    assertInvariants(base({ cost: "8000.0000", salvage: "500.0000", lifeMonths: 36, method, ratePercent: "25" }));
  }
});

test("input-driven methods cannot be mistaken for formula-generated schedules", () => {
  assert.throws(
    () => computeSchedule(base({ method: "manual" })),
    /manual depreciation requires a recorded period amount and evidence/,
  );
  assert.throws(
    () => computeSchedule(base({ method: "units_of_production" })),
    /units-of-production depreciation requires recorded period usage and lifetime units/,
  );
});

test("units-of-production uses an exact ratio and caps the salvage floor", () => {
  assert.equal(computeUnitsOfProductionCharge({
    cost: "100000.0000",
    salvage: "10000.0000",
    lifetimeUnits: "30000.0000",
    periodUnits: "333.3333",
    depreciationAlreadyPlanned: "0.0000",
  }), "999.9999");
  assert.equal(computeUnitsOfProductionCharge({
    cost: "100000.0000",
    salvage: "10000.0000",
    lifetimeUnits: "30000.0000",
    periodUnits: "1000.0000",
    depreciationAlreadyPlanned: "89500.0000",
  }), "500.0000");
});

test("units-of-production rejects invalid lifetime, usage, and prior basis", () => {
  const valid = {
    cost: "100.0000", salvage: "10.0000", lifetimeUnits: "1000.0000",
    periodUnits: "10.0000", depreciationAlreadyPlanned: "0.0000",
  };
  assert.throws(() => computeUnitsOfProductionCharge({ ...valid, lifetimeUnits: "0" }), /lifetime production units/);
  assert.throws(() => computeUnitsOfProductionCharge({ ...valid, periodUnits: "0" }), /period production units/);
  assert.throws(() => computeUnitsOfProductionCharge({ ...valid, depreciationAlreadyPlanned: "91" }), /exceeds the depreciable basis/);
});

test("units-of-production corrections are exact and cannot make lifetime usage negative", () => {
  assert.equal(computeUnitsOfProductionCharge({
    cost: "1000.0000", salvage: "100.0000", lifetimeUnits: "300.0000",
    periodUnits: "-25.0000", unitsAlreadyRecorded: "100.0000", depreciationAlreadyPlanned: "300.0000",
  }), "-75.0000");
  assert.throws(() => computeUnitsOfProductionCharge({
    cost: "1000.0000", salvage: "100.0000", lifetimeUnits: "300.0000",
    periodUnits: "-100.0001", unitsAlreadyRecorded: "100.0000", depreciationAlreadyPlanned: "300.0000",
  }), /between zero and expected lifetime units/);
});

test("final production units absorb exact rounding remainder", () => {
  const first = computeUnitsOfProductionCharge({
    cost: "1.0000", salvage: "0.0000", lifetimeUnits: "3.0000", periodUnits: "1.0000",
    unitsAlreadyRecorded: "0.0000", depreciationAlreadyPlanned: "0.0000",
  });
  const second = computeUnitsOfProductionCharge({
    cost: "1.0000", salvage: "0.0000", lifetimeUnits: "3.0000", periodUnits: "1.0000",
    unitsAlreadyRecorded: "1.0000", depreciationAlreadyPlanned: first,
  });
  const final = computeUnitsOfProductionCharge({
    cost: "1.0000", salvage: "0.0000", lifetimeUnits: "3.0000", periodUnits: "1.0000",
    unitsAlreadyRecorded: "2.0000", depreciationAlreadyPlanned: add(first, second),
  });
  assert.equal(add(add(first, second), final), "1.0000");
  assert.equal(final, "0.3334");
});
