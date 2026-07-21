import test from "node:test";
import assert from "node:assert/strict";
import { LaborRateError, resolveLaborRateStack, type LaborRateComponentInput, type LaborRateLineInput } from "./labor-rates.ts";

const dimensions = {
  employeePartyId: "employee",
  laborClassId: "journeyperson",
  itemId: "welding",
  timeTypeId: "ot",
  subsidiaryId: "sub",
  departmentId: "field",
  locationId: null,
  workerCompGroupId: "wsib",
};
const fixed = (overrides: Partial<LaborRateLineInput>): LaborRateLineInput => ({
  id: "line", code: "BASE", name: "Base", lane: "direct_cost", method: "fixed", amount: "40", percent: null,
  currency: "CAD", baseHours: "1", priority: 0, ...overrides,
});
const component = (overrides: Partial<LaborRateComponentInput>): LaborRateComponentInput => ({
  id: "component", code: "BURDEN", name: "Burden", lane: "cost", method: "fixed_per_hour", value: "0",
  currency: "CAD", sequence: 1, ...overrides,
});
const run = (lines: LaborRateLineInput[], components: LaborRateComponentInput[] = []) => resolveLaborRateStack({
  dimensions, hours: "10", isBillable: true, baseCurrency: "CAD", lines, components,
  employeeCompensation: null, timeCostMultiplier: "1.5", timeBillMultiplier: "1.5",
  fx: () => ({ rate: "1.0000000000", source: "same" }),
});

test("labor stack resolves direct, overtime, burden, and fixed bill rates exactly", () => {
  const result = run([
    fixed({}),
    fixed({ id: "bill", code: "BILL", name: "Customer rate", lane: "bill", amount: "100" }),
  ], [
    component({ id: "tax", code: "TAX", name: "Payroll tax", method: "percent_of_base_direct", value: "10" }),
    component({ id: "benefits", code: "BEN", name: "Benefits", value: "5" }),
  ]);
  assert.equal(result.directCostRate, "60.0000");
  assert.equal(result.burdenRate, "9.0000");
  assert.equal(result.costRate, "69.0000");
  assert.equal(result.billRate, "150.0000");
  assert.equal(result.standardCostAmount, "690.0000");
  assert.equal(result.billAmount, "1500.0000");
});

test("time-specific lines override generic lines without applying the multiplier twice", () => {
  const result = run([
    fixed({}),
    fixed({ id: "ot-cost", code: "OT", amount: "72", timeTypeId: "ot" }),
    fixed({ id: "bill", code: "BILL", lane: "bill", amount: "100" }),
    fixed({ id: "ot-bill", code: "OT-BILL", lane: "bill", amount: "140", timeTypeId: "ot" }),
  ]);
  assert.equal(result.directCostRate, "72.0000");
  assert.equal(result.billRate, "140.0000");
});

test("cost-plus markup and margin pricing use burdened cost", () => {
  const markup = run([fixed({}), fixed({ id: "bill", code: "BILL", lane: "bill", method: "markup_on_cost", amount: null, percent: "25" })]);
  assert.equal(markup.costRate, "60.0000");
  assert.equal(markup.billRate, "75.0000");
  const margin = run([fixed({}), fixed({ id: "bill", code: "BILL", lane: "bill", method: "margin_on_cost", amount: null, percent: "20" })]);
  assert.equal(margin.billRate, "75.0000");
});

test("equal-specificity rules are rejected rather than chosen silently", () => {
  assert.throws(() => run([
    fixed({ id: "a", code: "A" }), fixed({ id: "b", code: "B", amount: "45" }),
    fixed({ id: "bill", code: "BILL", lane: "bill", amount: "100" }),
  ]), (error: Error) => error instanceof LaborRateError && error.code === "ambiguous");
});

test("missing bill rate blocks billable work but not nonbillable work", () => {
  assert.throws(() => run([fixed({})]), /No bill rate/);
  const result = resolveLaborRateStack({
    dimensions, hours: "2", isBillable: false, baseCurrency: "CAD", lines: [fixed({})], components: [],
    employeeCompensation: null, timeCostMultiplier: "1", timeBillMultiplier: "1",
    fx: () => ({ rate: "1.0000000000", source: "same" }),
  });
  assert.equal(result.billRate, "0.0000");
});
