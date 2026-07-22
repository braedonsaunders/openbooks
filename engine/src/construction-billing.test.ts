import assert from "node:assert/strict";
import test from "node:test";
import { computeApplication, type AppLineInput } from "./construction-billing.ts";

const line = (over: Partial<AppLineInput>): AppLineInput => ({
  sovLineId: "l",
  scheduledValue: "10000",
  previousCompleted: "0",
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
