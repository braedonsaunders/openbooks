import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computeOpportunityTotals,
  matchesTerritory,
  rollupForecast,
  shouldPromoteLifecycle,
  validateContributionTotal,
  weightAmount,
} from "./crm-math.ts";

const crmSource = readFileSync(new URL("./crm.ts", import.meta.url), "utf8");

test("customer-role upserts pin the known tenant on the party_id conflict write", () => {
  assert.match(
    crmSource,
    /on conflict \(party_id\) do update set[\s\S]*?where customer_roles\.org_id = \$\{input\.orgId\}/,
  );
});

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
  // Weighted sums each line's own rounding (44.9998 @ 75% + 8.3325 @ 25%),
  // not the header rate applied to the projected total.
  assert.equal(totals.weightedAmount, "53.3323");
  assert.equal(weightAmount("0.0001", 50), "0.0001");
});

test("weighted totals honor per-line probability overrides with header fallback", () => {
  const totals = computeOpportunityTotals([
    { quantity: "100.0000", unitPrice: "1.0000", probability: 100 },
    { quantity: "40.0000", unitPrice: "1.0000" },
  ], 20);
  assert.equal(totals.lines[0]?.probability, 100);
  assert.equal(totals.lines[0]?.expectedAmount, "100.0000");
  assert.equal(totals.lines[1]?.probability, 20);
  assert.equal(totals.lines[1]?.expectedAmount, "8.0000");
  assert.equal(totals.weightedAmount, "108.0000");
});

test("probability bounds stay guarded at zero and reject invalid rates", () => {
  assert.equal(weightAmount("123.4567", 0), "0.0000");
  assert.equal(weightAmount("123.4567", 100), "123.4567");
  assert.throws(() => weightAmount("10.0000", -1), /integer from 0 to 100/);
  assert.throws(() => weightAmount("10.0000", 101), /integer from 0 to 100/);
  assert.throws(() => weightAmount("10.0000", 12.5), /integer from 0 to 100/);
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
