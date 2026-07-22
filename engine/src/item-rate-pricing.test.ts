import assert from "node:assert/strict";
import test from "node:test";
import { priceCappedLadder, priceLowestCost, priceSelectedRateUnit, type RateTier } from "./item-rate-pricing.ts";

const legacy: RateTier[] = [
  { id: "day", unitCode: "day", unitName: "Day", baseQuantity: "1", costRate: "0", billRate: "100" },
  { id: "week", unitCode: "week", unitName: "Week", baseQuantity: "4", costRate: "0", billRate: "250" },
  { id: "month", unitCode: "month", unitName: "Month", baseQuantity: "12", costRate: "0", billRate: "800" },
];

test("capped ladder reproduces adminapp2 1/4/12 roll-up", () => {
  const result = priceCappedLadder("15", legacy, "bill");
  assert.equal(result.amount, "1050.0000");
  assert.deepEqual(result.components.map((c) => [c.unitCode, c.quantity]), [["month", "1.0000"], ["week", "1.0000"]]);
});

test("capped ladder matches the legacy three-day and eleven-day boundary cases", () => {
  const sourceRates: RateTier[] = [
    { unitCode: "day", unitName: "Day", baseQuantity: "1", costRate: "0", billRate: "10" },
    { unitCode: "week", unitName: "Week", baseQuantity: "4", costRate: "0", billRate: "25" },
    { unitCode: "month", unitName: "Month", baseQuantity: "12", costRate: "0", billRate: "70" },
  ];
  assert.equal(priceCappedLadder("3", sourceRates, "bill").amount, "25.0000");
  assert.equal(priceCappedLadder("11", sourceRates, "bill").amount, "70.0000");
});

test("capped ladder preserves strict greater-than promotion", () => {
  const tiers = legacy.map((t) => t.unitCode === "week" ? { ...t, billRate: "300" } : t);
  const result = priceCappedLadder("3", tiers, "bill");
  assert.equal(result.amount, "300.0000");
  assert.equal(result.components[0]!.unitCode, "day");
  assert.equal(result.components[0]!.quantity, "3.0000");
});

test("zero cost and positive billing price are independent", () => {
  assert.equal(priceCappedLadder("7", legacy, "cost").amount, "0.0000");
  assert.equal(priceCappedLadder("7", legacy, "bill").amount, "500.0000");
});

test("lowest-cost pricing supports arbitrary N package units", () => {
  const tiers: RateTier[] = [
    { unitCode: "hour", unitName: "Hour", baseQuantity: "1", costRate: "10", billRate: "20" },
    { unitCode: "shift", unitName: "Shift", baseQuantity: "8", costRate: "60", billRate: "120" },
    { unitCode: "week", unitName: "Week", baseQuantity: "40", costRate: "250", billRate: "450" },
  ];
  const result = priceLowestCost("45", tiers, "bill");
  assert.equal(result.amount, "550.0000");
  assert.deepEqual(result.components.map((c) => [c.unitCode, c.quantity]), [["week", "1.0000"], ["hour", "5.0000"]]);
});

test("an explicitly selected package is not promoted or decomposed", () => {
  const result = priceSelectedRateUnit("2", legacy[1]!, "bill");
  assert.equal(result.amount, "500.0000");
  assert.deepEqual(result.components.map((c) => [c.unitCode, c.quantity, c.rate]), [["week", "2.0000", "250"]]);
});
