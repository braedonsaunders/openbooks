import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeCostRate, convertFixedLaborComponents, convertLaborWage, type LaborCostComponent } from "./labor-costing.ts";

const cfg = (components: LaborCostComponent[], hoursPerDay = 8) => ({ hoursPerDay, components });

test("wage only — multiplier applies", () => {
  assert.equal(computeCostRate("40", "1", cfg([])), "40.0000");
  assert.equal(computeCostRate("40", "1.5", cfg([])), "60.0000");
  assert.equal(computeCostRate("40", "2", cfg([])), "80.0000");
});

test("percent_of_wage scales with overtime when flagged", () => {
  const burden: LaborCostComponent = { key: "b", name: "Burden", kind: "percent_of_wage", value: 13, scaleWithOvertime: true };
  // 40×1.5 + 13% of 60 = 60 + 7.80
  assert.equal(computeCostRate("40", "1.5", cfg([burden])), "67.8000");
});

test("percent_of_wage on base wage when not scaled", () => {
  const burden: LaborCostComponent = { key: "b", name: "Burden", kind: "percent_of_wage", value: 13, scaleWithOvertime: false };
  // 40×1.5 + 13% of 40 = 60 + 5.20
  assert.equal(computeCostRate("40", "1.5", cfg([burden])), "65.2000");
});

test("per_day prorates by hoursPerDay and never scales", () => {
  const perdiem: LaborCostComponent = { key: "pd", name: "Per diem", kind: "per_day", value: 64 };
  // 40 + 64/8 = 48; OT: 40×2 + 8 = 88 (per-diem unchanged)
  assert.equal(computeCostRate("40", "1", cfg([perdiem])), "48.0000");
  assert.equal(computeCostRate("40", "2", cfg([perdiem])), "88.0000");
});

test("per_hour flat vs scaled", () => {
  const flat: LaborCostComponent = { key: "f", name: "Flat", kind: "per_hour", value: 3 };
  const scaled: LaborCostComponent = { key: "s", name: "Scaled", kind: "per_hour", value: 3, scaleWithOvertime: true };
  assert.equal(computeCostRate("40", "1.5", cfg([flat])), "63.0000");
  assert.equal(computeCostRate("40", "1.5", cfg([scaled])), "64.5000");
});

test("rassaun-style stack: burden % + per diem", () => {
  const comps: LaborCostComponent[] = [
    { key: "burden", name: "Payroll burden (est.)", kind: "percent_of_wage", value: 14, scaleWithOvertime: true },
    { key: "perdiem", name: "Per diem", kind: "per_day", value: 60 },
  ];
  // 38×1 + 5.32 + 7.50 = 50.82
  assert.equal(computeCostRate("38", "1", cfg(comps)), "50.8200");
});

test("zero and missing values are ignored", () => {
  const comps: LaborCostComponent[] = [
    { key: "z", name: "Zero", kind: "percent_of_wage", value: 0 },
    { key: "n", name: "NaN", kind: "per_hour", value: Number.NaN },
  ];
  assert.equal(computeCostRate("40", "1", cfg(comps)), "40.0000");
});

test("worker_comp uses the employee's group rate, not the fallback", () => {
  const comps: LaborCostComponent[] = [
    { key: "wc", name: "WSIB", kind: "worker_comp", value: 3, scaleWithOvertime: true },
  ];
  // group rate 5% beats the 3% fallback: 40 + 5% of 40 = 42
  assert.equal(computeCostRate("40", "1", cfg(comps), { workerCompPercent: 5 }), "42.0000");
  // OT: 40×1.5 + 5% of 60 = 63
  assert.equal(computeCostRate("40", "1.5", cfg(comps), { workerCompPercent: 5 }), "63.0000");
});

test("worker_comp falls back to component value when no group assigned", () => {
  const comps: LaborCostComponent[] = [
    { key: "wc", name: "WSIB", kind: "worker_comp", value: 3, scaleWithOvertime: false },
  ];
  // no override → 3% of base wage: 40 + 1.2 = 41.2
  assert.equal(computeCostRate("40", "1", cfg(comps)), "41.2000");
});

test("worker_comp with a 0% group adds nothing", () => {
  const comps: LaborCostComponent[] = [
    { key: "wc", name: "WSIB", kind: "worker_comp", value: 3, scaleWithOvertime: true },
  ];
  assert.equal(computeCostRate("40", "1", cfg(comps), { workerCompPercent: 0 }), "40.0000");
});

test("labor wage FX conversion is exact to numeric(19,4)", () => {
  assert.equal(convertLaborWage("40", "1.3725"), "54.9000");
  assert.equal(convertLaborWage("0", "1.3725"), "0.0000");
  assert.equal(convertLaborWage("38.125", "0.7312345678"), "27.8783");
});

test("only fixed labor components convert to subsidiary functional currency", () => {
  const components: LaborCostComponent[] = [
    { key: "pct", name: "Burden", kind: "percent_of_wage", value: 13 },
    { key: "hour", name: "Allowance", kind: "per_hour", value: 3 },
    { key: "day", name: "Per diem", kind: "per_day", value: 60 },
  ];
  assert.deepEqual(convertFixedLaborComponents(components, "0.75"), [
    components[0],
    { ...components[1], value: 2.25 },
    { ...components[2], value: 45 },
  ]);
});
