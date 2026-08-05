import assert from "node:assert/strict";
import { test } from "node:test";
import { toUnits } from "./money.ts";
import {
  consumeFifo,
  extendCost,
  issueMovingAverage,
  issueStandard,
  receiveMovingAverage,
  receiveStandard,
  toBaseQuantity,
  type CostLayer,
} from "./inventory-costing.ts";

// ---------------------------------------------------------------------------
// extendCost / unit conversion
// ---------------------------------------------------------------------------

test("extendCost multiplies quantity by unit cost, rounded to 4dp", () => {
  assert.equal(extendCost("3", "2.50"), "7.5000");
  assert.equal(extendCost("1.5", "3.3333"), "5.0000"); // 4.99995 → 5.0000
});

test("toBaseQuantity applies the item's unit conversion, else 1:1", () => {
  const conv = { box: 12, pallet: 720 };
  assert.equal(toBaseQuantity("2", "box", conv, "ea"), "24.0000");
  assert.equal(toBaseQuantity("5", "ea", conv, "ea"), "5.0000");
  assert.equal(toBaseQuantity("5", "unknown", conv, "ea"), "5.0000");
});

// ---------------------------------------------------------------------------
// FIFO
// ---------------------------------------------------------------------------

const layers = (): CostLayer[] => [
  { id: "a", remaining: "10", unitCost: "2.00" },
  { id: "b", remaining: "10", unitCost: "3.00" },
];

test("FIFO consumes the oldest layer first at its cost", () => {
  const r = consumeFifo(layers(), "6", "0");
  assert.equal(r.consumptions.length, 1);
  assert.equal(r.consumptions[0].layerId, "a");
  assert.equal(r.totalCost, "12.0000"); // 6 × 2.00
  assert.equal(r.shortfallQuantity, "0");
});

test("FIFO spans layers and costs each at its own rate", () => {
  const r = consumeFifo(layers(), "15", "0");
  assert.equal(r.consumptions.length, 2);
  assert.equal(r.consumptions[0].cost, "20.0000"); // 10 × 2.00
  assert.equal(r.consumptions[1].cost, "15.0000"); // 5 × 3.00
  assert.equal(r.totalCost, "35.0000");
  assert.equal(r.shortfallQuantity, "0");
});

test("FIFO reports a shortfall costed at the fallback when stock runs out", () => {
  const r = consumeFifo(layers(), "25", "3.50");
  assert.equal(r.shortfallQuantity, "5.0000");
  assert.equal(r.shortfallCost, "17.5000"); // 5 × 3.50
  // 20 (layer a) + 30 (layer b) + 17.5 (shortfall) = 67.5
  assert.equal(r.totalCost, "67.5000");
});

test("FIFO consumption cost never exceeds available layer value (round-trip is exact)", () => {
  const ls: CostLayer[] = [{ id: "x", remaining: "3", unitCost: "1.3333" }];
  const r = consumeFifo(ls, "3", "0");
  assert.equal(r.totalCost, extendCost("3", "1.3333")); // both rounded the same way
});

// ---------------------------------------------------------------------------
// Moving average
// ---------------------------------------------------------------------------

test("moving average blends receipts by value", () => {
  let s = { quantity: "0", value: "0" };
  s = receiveMovingAverage(s, "10", "2.00"); // value 20
  s = receiveMovingAverage(s, "10", "4.00"); // value 60, qty 20 → avg 3.00
  assert.equal(s.quantity, "20.0000");
  assert.equal(s.value, "60.0000");
  const iss = issueMovingAverage(s, "5");
  assert.equal(iss.unitCost, "3.0000");
  assert.equal(iss.cost, "15.0000");
  assert.equal(iss.state.value, "45.0000");
  assert.equal(iss.state.quantity, "15.0000");
});

test("moving average drains to exactly zero value when the last unit ships", () => {
  let s = { quantity: "3", value: "10" }; // avg 3.3333…
  const iss = issueMovingAverage(s, "3");
  assert.equal(iss.cost, "10.0000"); // takes ALL remaining value, no rounding residue
  assert.equal(iss.state.quantity, "0.0000");
  assert.equal(iss.state.value, "0.0000");
});

test("moving average partial issue leaves value proportional and non-negative", () => {
  const s = { quantity: "3", value: "10" };
  const iss = issueMovingAverage(s, "1");
  // 10 × 1 / 3 = 3.3333
  assert.equal(iss.cost, "3.3333");
  assert.equal(iss.state.value, "6.6667");
  assert.equal(toUnits(iss.state.value) + toUnits(iss.cost), toUnits("10"));
});

// ---------------------------------------------------------------------------
// Standard cost
// ---------------------------------------------------------------------------

test("standard-cost receipt books inventory at standard and PPV for the delta", () => {
  const r = receiveStandard("10", "2.20", "2.00");
  assert.equal(r.inventoryValue, "20.0000"); // 10 × 2.00 standard
  assert.equal(r.variance, "2.0000"); // 10 × (2.20 − 2.00) unfavorable
});

test("standard-cost receipt yields a favorable (negative) variance when actual is below standard", () => {
  const r = receiveStandard("10", "1.90", "2.00");
  assert.equal(r.variance, "-1.0000");
});

test("standard-cost issue is always at standard", () => {
  assert.equal(issueStandard("7", "2.00"), "14.0000");
});
