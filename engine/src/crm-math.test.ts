import assert from "node:assert/strict";
import test from "node:test";
import {
  computeOpportunityTotals,
  matchesTerritory,
  rollupForecast,
  shouldPromoteLifecycle,
  validateContributionTotal,
  weightAmount,
} from "./crm-math.ts";

test("lifecycle promotion is forward-only", () => {
  assert.equal(shouldPromoteLifecycle("lead", "prospect"), true);
  assert.equal(shouldPromoteLifecycle("lead", "customer"), true);
  assert.equal(shouldPromoteLifecycle("customer", "prospect"), false);
});

test("opportunity totals and weighting are exact at four decimals", () => {
  const totals = computeOpportunityTotals([
    { quantity: "3.0000", unitPrice: "19.9999" },
    { quantity: "0.3333", unitPrice: "100.0000", probability: 25 },
  ], 75);
  assert.equal(totals.lines[0]?.amount, "59.9997");
  assert.equal(totals.lines[1]?.amount, "33.3300");
  assert.equal(totals.lines[1]?.expectedAmount, "8.3325");
  assert.equal(totals.projectedAmount, "93.3297");
  assert.equal(totals.weightedAmount, "69.9973");
  assert.equal(weightAmount("0.0001", 50), "0.0001");
});

test("sales-team contributions must total exactly one hundred percent", () => {
  assert.doesNotThrow(() => validateContributionTotal(["60", "40"]));
  assert.throws(() => validateContributionTotal(["60", "39.9999"]), /exactly 100/);
  assert.throws(() => validateContributionTotal(["100", "0"]), /positive/);
});

test("forecast rollup excludes omitted deals and keeps categories distinct", () => {
  assert.deepEqual(rollupForecast([
    { amount: "100.0000", weightedAmount: "75.0000", category: "most_likely" },
    { amount: "40.0000", weightedAmount: "10.0000", category: "upside" },
    { amount: "25.0000", weightedAmount: "0.0000", category: "omitted" },
    { amount: "60.0000", weightedAmount: "60.0000", category: "worst_case", closedWon: true },
  ]), {
    pipelineAmount: "140.0000",
    weightedAmount: "85.0000",
    worstCaseAmount: "0.0000",
    mostLikelyAmount: "100.0000",
    upsideAmount: "40.0000",
    closedAmount: "60.0000",
  });
});

test("territory rules support deterministic exact comparisons", () => {
  const subject = { lifecycleStage: "lead" as const, country: "CA", region: "Ontario", annualRevenue: "2500000.0000", employeeCount: 45 };
  assert.equal(matchesTerritory(subject, [
    { field: "country", operator: "equals", value: "ca" },
    { field: "annualRevenue", operator: "gte", value: "2000000" },
    { field: "employeeCount", operator: "lte", value: 50 },
  ], "all"), true);
  assert.equal(matchesTerritory(subject, [{ field: "region", operator: "equals", value: "Quebec" }], "all"), false);
});
