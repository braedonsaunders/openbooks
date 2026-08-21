import assert from "node:assert/strict";
import test from "node:test";
import {
  ConstructionBillingError,
  computeApplication,
  revisedScheduleValue,
  type AppLineInput,
} from "./construction-billing.ts";

const line = (over: Partial<AppLineInput>): AppLineInput => ({
  sovLineId: "l",
  scheduledValue: "10000",
  previousCompleted: "0",
  previousMaterialsStored: "0",
  thisPeriodCompleted: "0",
  materialsStored: "0",
  retainagePercent: "10",
  ...over,
});

test("withholds retainage on this period's gross and nets the current due", () => {
  const r = computeApplication([
    line({ sovLineId: "a", previousCompleted: "2000", thisPeriodCompleted: "3000" }),
  ]);
  assert.equal(r.lines[0]!.grossThisPeriod, "3000.0000");
  assert.equal(r.lines[0]!.retainageThisPeriod, "300.0000");
  assert.equal(r.lines[0]!.netThisPeriod, "2700.0000");
  assert.equal(r.lines[0]!.completedToDate, "5000.0000");
  assert.equal(r.lines[0]!.percentComplete, "50.00");
  assert.equal(r.grossThisPeriod, "3000.0000");
  assert.equal(r.retainageThisPeriod, "300.0000");
  assert.equal(r.currentDue, "2700.0000");
});

test("materials stored are billable and carry retainage too", () => {
  const r = computeApplication([
    line({ thisPeriodCompleted: "1000", materialsStored: "500", retainagePercent: "10" }),
  ]);
  assert.equal(r.grossThisPeriod, "1500.0000");
  assert.equal(r.retainageThisPeriod, "150.0000");
  assert.equal(r.currentDue, "1350.0000");
});

test("re-entering the stored balance bills only the increment", () => {
  // Application #2: the PM re-enters the same cumulative 500 stored balance, so
  // only this period's work bills — the stored materials are not billed twice.
  const r = computeApplication([
    line({ previousCompleted: "1500", previousMaterialsStored: "500", thisPeriodCompleted: "1000", materialsStored: "500" }),
  ]);
  assert.equal(r.lines[0]!.grossThisPeriod, "1000.0000");
  assert.equal(r.lines[0]!.retainageThisPeriod, "100.0000");
  assert.equal(r.lines[0]!.netThisPeriod, "900.0000");
  assert.equal(r.lines[0]!.completedToDate, "2500.0000");
  assert.equal(r.grossThisPeriod, "1000.0000");
  assert.equal(r.currentDue, "900.0000");
});

test("a rising stored balance bills only the delta", () => {
  const r = computeApplication([
    line({ previousCompleted: "2500", previousMaterialsStored: "500", thisPeriodCompleted: "0", materialsStored: "800" }),
  ]);
  assert.equal(r.lines[0]!.grossThisPeriod, "300.0000");
  assert.equal(r.lines[0]!.retainageThisPeriod, "30.0000");
  assert.equal(r.lines[0]!.completedToDate, "2800.0000");
  assert.equal(r.currentDue, "270.0000");
});

test("stored below the previously billed balance is rejected", () => {
  // Billed materials have left the site — a negative draw cannot express that.
  assert.throws(
    () => computeApplication([line({ previousMaterialsStored: "500", materialsStored: "400" })]),
    /credit or adjusting entry/,
  );
});

test("work-only path is byte-identical when nothing was stored before", () => {
  const r = computeApplication([
    line({ previousCompleted: "2000", previousMaterialsStored: "0", thisPeriodCompleted: "3000", materialsStored: "0" }),
  ]);
  assert.equal(r.lines[0]!.grossThisPeriod, "3000.0000");
  assert.equal(r.lines[0]!.retainageThisPeriod, "300.0000");
  assert.equal(r.lines[0]!.netThisPeriod, "2700.0000");
  assert.equal(r.lines[0]!.completedToDate, "5000.0000");
  assert.equal(r.currentDue, "2700.0000");
});

test("a zero-retainage line bills gross with nothing withheld", () => {
  const r = computeApplication([line({ thisPeriodCompleted: "4000", retainagePercent: "0" })]);
  assert.equal(r.retainageThisPeriod, "0.0000");
  assert.equal(r.currentDue, "4000.0000");
});

test("totals sum exactly across mixed lines (no drift)", () => {
  const r = computeApplication([
    line({ sovLineId: "a", thisPeriodCompleted: "3333.33", retainagePercent: "10" }),
    line({ sovLineId: "b", thisPeriodCompleted: "3333.33", retainagePercent: "5" }),
    line({ sovLineId: "c", thisPeriodCompleted: "3333.34", retainagePercent: "0" }),
  ]);
  // gross 10000.00; retainage = 333.333 + 166.6665 → rounded per line 333.3330 + 166.6665 = 499.9995
  assert.equal(r.grossThisPeriod, "10000.0000");
  assert.equal(r.retainageThisPeriod, "499.9995");
  assert.equal(r.currentDue, "9500.0005");
});

test("rejects overbilling beyond the schedule of values", () => {
  assert.throws(
    () => computeApplication([line({ scheduledValue: "10000", previousCompleted: "9000", thisPeriodCompleted: "1001" })]),
    /exceeds the scheduled value/,
  );
});

test("scheduled-value cap still bounds completedToDate with stored increments", () => {
  const args = { scheduledValue: "10000", previousCompleted: "9500", previousMaterialsStored: "500" };
  // Stored rising 500 → 600 adds only 100 to the draw: 9500 + 400 + 100 lands
  // exactly on the schedule and is allowed.
  const atCap = computeApplication([line({ ...args, thisPeriodCompleted: "400", materialsStored: "600" })]);
  assert.equal(atCap.lines[0]!.completedToDate, "10000.0000");
  assert.equal(atCap.lines[0]!.grossThisPeriod, "500.0000");
  // One cent past the cap is refused.
  assert.throws(
    () => computeApplication([line({ ...args, thisPeriodCompleted: "400.01", materialsStored: "600" })]),
    /exceeds the scheduled value/,
  );
});

test("rejects negative application amounts and invalid retainage", () => {
  assert.throws(() => computeApplication([line({ thisPeriodCompleted: "-1" })]), /cannot be negative/);
  assert.throws(() => computeApplication([line({ thisPeriodCompleted: "1", retainagePercent: "101" })]), /between 0 and 100/);
});

test("change orders revise an SOV line exactly without binary rounding", () => {
  assert.equal(revisedScheduleValue("100000.1000", "1250.2555", "40000.0000"), "101250.3555");
  assert.equal(revisedScheduleValue("100000.1000", "-1250.2555", "40000.0000"), "98749.8445");
});

test("deductive change orders cannot reduce below already-billed work", () => {
  assert.throws(
    () => revisedScheduleValue("100000.0000", "-60000.0001", "40000.0000"),
    ConstructionBillingError,
  );
  assert.equal(revisedScheduleValue("100000.0000", "-60000.0000", "40000.0000"), "40000.0000");
});
