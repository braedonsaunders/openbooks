import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeCostRate, type LaborCostComponent } from "./labor-costing.ts";

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
