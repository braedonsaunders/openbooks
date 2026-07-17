import assert from "node:assert/strict";
import test from "node:test";
import {
  computePoolYear,
  resolvePoolClass,
  TAX_DEPRECIATION_REGIMES,
  type PoolYearInput,
} from "./tax-depreciation-pool.ts";

const run = (over: Partial<PoolYearInput>): ReturnType<typeof computePoolYear> =>
  computePoolYear({ openingBalance: "0", additions: "0", dispositions: "0", rate: 0.2, ...over });

// The Canada CCA half-year rule is just firstYearFraction 0.5 on a generic pool.
test("first-year fraction (Canada half-year rule) halves year-1 additions", () => {
  const r = run({ additions: "10000", firstYearFraction: 0.5 });
  assert.equal(r.base, "5000.00");
  assert.equal(r.allowance, "1000.00");
  assert.equal(r.closingBalance, "9000.00");
});

test("year 2 depreciates the full opening balance", () => {
  const r = run({ openingBalance: "9000" });
  assert.equal(r.allowance, "1800.00");
  assert.equal(r.closingBalance, "7200.00");
});

test("enhanced first-year multiplier (Canada AII) suspends the fraction and boosts the base", () => {
  const r = run({ additions: "10000", firstYearFraction: 0.5, enhancedFirstYearMultiplier: 1.5 });
  assert.equal(r.base, "15000.00");
  assert.equal(r.allowance, "3000.00");
});

test("full first-year fraction (exempt class) takes the full rate immediately", () => {
  const r = run({ additions: "5000", rate: 1.0, firstYearFraction: 1 });
  assert.equal(r.allowance, "5000.00");
  assert.equal(r.closingBalance, "0.00");
});

test("recapture / balancing charge when disposals exceed the pool", () => {
  const r = run({ openingBalance: "2000", dispositions: "5000" });
  assert.equal(r.recapture, "3000.00");
  assert.equal(r.closingBalance, "0.00");
});

test("terminal loss when the pool empties with value left", () => {
  const r = run({ openingBalance: "3000", poolHasAssetsAtYearEnd: false });
  assert.equal(r.terminalLoss, "3000.00");
});

test("short fiscal year prorates the allowance", () => {
  const r = run({ openingBalance: "10000", rate: 0.3, shortYearFactor: 0.5 });
  assert.equal(r.allowance, "1500.00");
});

test("discretionary claim cap limits the allowance and preserves the balance", () => {
  const r = run({ openingBalance: "10000", claimCap: "500" });
  assert.equal(r.allowance, "500.00");
  assert.equal(r.closingBalance, "9500.00");
});

test("regimes that disallow recapture (Canada Class 10.1) just zero the pool", () => {
  const r = run({ openingBalance: "1000", dispositions: "5000", allowRecapture: false });
  assert.equal(r.recapture, "0.00");
  assert.equal(r.closingBalance, "0.00");
});

test("immediate expensing fully deducts before the rate", () => {
  const r = run({ additions: "100000", immediateExpense: "100000", rate: 0.55, firstYearFraction: 0.5 });
  assert.equal(r.immediateExpense, "100000.00");
  assert.equal(r.allowance, "0.00");
  assert.equal(r.closingBalance, "0.00");
});

// The Canada CCA regime is data, driving the same generic engine.
test("Canada CCA is a configured regime, not hardcoded logic", () => {
  const c8 = resolvePoolClass("ca_cca", "8")!;
  assert.equal(c8.rate, 0.2);
  assert.equal(c8.firstYearFraction, 0.5); // half-year rule
  assert.equal(resolvePoolClass("ca_cca", "50")!.rate, 0.55);
  assert.equal(resolvePoolClass("ca_cca", "10.1")!.allowRecapture, false);
  assert.equal(TAX_DEPRECIATION_REGIMES.ca_cca!.name, "Canada — Capital Cost Allowance");

  // Run a real Class 8 year straight from the regime config.
  const r = computePoolYear({
    openingBalance: "0", additions: "10000", dispositions: "0",
    rate: c8.rate, firstYearFraction: c8.firstYearFraction,
  });
  assert.equal(r.allowance, "1000.00");
});
