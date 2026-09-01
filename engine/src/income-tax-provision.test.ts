import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProvision,
  deferredAssetAdjustmentLabel,
  hasPriorDeferredTaxMeasurement,
} from "./income-tax-provision.ts";

test("framework changes recognition language, not math (ASC 740 vs IAS 12)", () => {
  const base = {
    pretaxBookIncome: "1000000",
    enactedRatePercent: "26.5",
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    valuationAllowance: "10000",
    differences: [{ category: "provisions" as const, description: "Accrued warranty", difference: "-80000", source: "manual" as const }],
  };
  const us = buildProvision({ ...base, framework: "asc740" });
  const ifrs = buildProvision({ ...base, framework: "ias12" });
  assert.equal(us.totalExpense, ifrs.totalExpense, "identical computation under both frameworks");
  const usStep = us.rateReconciliation.find((s) => s.key === "deferredMovement")!;
  const ifrsStep = ifrs.rateReconciliation.find((s) => s.key === "deferredMovement")!;
  assert.ok(usStep.label.includes("valuation allowance"));
  assert.ok(ifrsStep.label.includes("deferred tax asset recognition adjustment"));
  assert.equal(deferredAssetAdjustmentLabel("asc740"), "Valuation allowance");
  assert.equal(deferredAssetAdjustmentLabel("ias12"), "Deferred tax asset recognition adjustment");
});

const RATE = "26.5";

test("inactive entities with prior deferred balances remain in the unwind plan", () => {
  const prior = {
    dtaGross: "10000",
    dtlGross: "0",
    valuationAllowance: "0",
    netTemporaryDifference: "-37735.8491",
  };
  assert.equal(hasPriorDeferredTaxMeasurement(prior), true);
  assert.equal(
    hasPriorDeferredTaxMeasurement({
      dtaGross: "0",
      dtlGross: "0",
      valuationAllowance: "0",
      netTemporaryDifference: "0",
    }),
    false,
  );

  const unwind = buildProvision({
    pretaxBookIncome: "0",
    enactedRatePercent: RATE,
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    valuationAllowance: "0",
    differences: [],
    prior: {
      dtaGross: prior.dtaGross,
      dtlGross: prior.dtlGross,
      valuationAllowance: prior.valuationAllowance,
    },
    priorNetTemporaryDifference: prior.netTemporaryDifference,
  });
  assert.equal(unwind.movement.dtaGross, "-10000.0000");
  assert.equal(unwind.deferredExpense, "10000.0000");
});

test("provision on plain pretax income: current tax only, effective rate = statutory", () => {
  const c = buildProvision({
    pretaxBookIncome: "1000000",
    enactedRatePercent: RATE,
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    valuationAllowance: "0",
    differences: [],
  });
  assert.equal(c.taxableIncome, "1000000.0000");
  assert.equal(c.currentTax, "265000.0000");
  assert.equal(c.deferredExpense, "0.0000");
  assert.equal(c.totalExpense, "265000.0000");
  assert.equal(c.effectiveRatePercent, "26.50");
  const total = c.rateReconciliation.find((s) => s.key === "total")!;
  assert.equal(total.amount, "265000.0000");
});

test("permanent differences and loss carryforward shape the current tax", () => {
  const c = buildProvision({
    pretaxBookIncome: "1000000",
    enactedRatePercent: RATE,
    permanentDifferences: [{ description: "Non-deductible meals", amount: "50000" }],
    lossCarryforwardUsed: "100000",
    valuationAllowance: "0",
    differences: [],
  });
  assert.equal(c.taxableIncome, "950000.0000");
  assert.equal(c.currentTax, "251750.0000");
  const keys = c.rateReconciliation.map((s) => s.key);
  assert.ok(keys.includes("permanent:Non-deductible meals"));
  assert.ok(keys.includes("lossCarryforward"));
});

test("temporary differences shift tax between current and deferred, not the total", () => {
  const c = buildProvision({
    pretaxBookIncome: "1000000",
    enactedRatePercent: RATE,
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    valuationAllowance: "0",
    differences: [
      { category: "fixed_assets", description: "P&E book vs tax", difference: "200000", source: "auto" },
      { category: "provisions", description: "Accrued warranty", difference: "-80000", source: "manual" },
    ],
  });
  // Originating net taxable difference of 120,000 defers tax: taxable profit is
  // 880,000 (ASC 740-10-30-2), current tax falls, deferred rises, and for pure
  // timing the TOTAL equals the statutory charge on book income.
  assert.equal(c.netTemporaryDifference, "120000.0000");
  assert.equal(c.taxableIncome, "880000.0000");
  assert.equal(c.currentTax, "233200.0000");
  assert.equal(c.balances.dtlGross, "53000.0000");
  assert.equal(c.balances.dtaGross, "21200.0000");
  assert.equal(c.deferredExpense, "31800.0000"); // 53,000 − 21,200
  assert.equal(c.totalExpense, "265000.0000"); // = 26.5% × 1,000,000
  assert.equal(c.effectiveRatePercent, "26.50");
  assert.equal(c.measured[0]!.ratePercent, RATE);
  assert.equal(c.measured[0]!.taxEffect, "53000.0000");
  assert.equal(c.measured[1]!.taxEffect, "-21200.0000");
});

test("a reversing temporary difference brings current tax back without touching the total", () => {
  // Prior cumulative net taxable difference 120,000 fully reverses this year:
  // book depreciation now exceeds tax depreciation, taxable profit exceeds
  // book income, and the deferred balances drain back through current tax.
  const c = buildProvision({
    pretaxBookIncome: "1000000",
    enactedRatePercent: RATE,
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    valuationAllowance: "0",
    differences: [],
    prior: { dtaGross: "21200", dtlGross: "53000", valuationAllowance: "0" },
    priorNetTemporaryDifference: "120000",
  });
  assert.equal(c.taxableIncome, "1120000.0000");
  assert.equal(c.currentTax, "296800.0000");
  assert.equal(c.deferredExpense, "-31800.0000"); // DTL and DTA both release
  assert.equal(c.totalExpense, "265000.0000"); // still the statutory charge
});

test("loss carryforwards are attributes, not basis differences — they never adjust taxable profit", () => {
  const c = buildProvision({
    pretaxBookIncome: "1000000",
    enactedRatePercent: RATE,
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    valuationAllowance: "0",
    differences: [
      { category: "loss_carryforward", description: "Unused losses", difference: "-400000", source: "manual" },
    ],
  });
  // The carryforward DTA is measured, but taxable profit is untouched: the
  // loss was already a book loss in the year it arose, not a basis difference.
  assert.equal(c.netTemporaryDifference, "0.0000");
  assert.equal(c.taxableIncome, "1000000.0000");
  assert.equal(c.currentTax, "265000.0000");
  assert.equal(c.balances.dtaGross, "106000.0000");
});

test("valuation allowance reduces the DTA and cannot exceed it", () => {
  const base = {
    pretaxBookIncome: "1000000",
    enactedRatePercent: RATE,
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    differences: [{ category: "provisions" as const, description: "Accrued warranty", difference: "-80000", source: "manual" as const }],
  };
  const c = buildProvision({ ...base, valuationAllowance: "10000" });
  assert.equal(c.balances.dtaGross, "21200.0000");
  assert.equal(c.balances.valuationAllowance, "10000.0000");
  assert.equal(c.deferredExpense, "-11200.0000"); // −21,200 DTA increase + 10,000 VA increase
  assert.throws(() => buildProvision({ ...base, valuationAllowance: "30000" }), /cannot exceed/);
});

test("movement is measured from the last posted run's balances", () => {
  const c = buildProvision({
    pretaxBookIncome: "1000000",
    enactedRatePercent: RATE,
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    valuationAllowance: "10000",
    differences: [
      { category: "fixed_assets", description: "P&E", difference: "200000", source: "auto" },
      { category: "provisions", description: "Warranty", difference: "-80000", source: "manual" },
    ],
    prior: { dtaGross: "5000", dtlGross: "20000", valuationAllowance: "0" },
  });
  assert.equal(c.movement.dtlGross, "33000.0000"); // 53,000 − 20,000
  assert.equal(c.movement.dtaGross, "16200.0000"); // 21,200 − 5,000
  assert.equal(c.movement.valuationAllowance, "10000.0000");
  assert.equal(c.deferredExpense, "26800.0000"); // 33,000 − 16,200 + 10,000
});

test("a loss year recognizes no current tax and reconciles through the not-recognized step", () => {
  const c = buildProvision({
    pretaxBookIncome: "-500000",
    enactedRatePercent: RATE,
    permanentDifferences: [],
    lossCarryforwardUsed: "0",
    valuationAllowance: "0",
    differences: [{ category: "loss_carryforward", description: "Current-year loss carried forward", difference: "-500000", source: "manual" }],
  });
  assert.equal(c.currentTax, "0.0000");
  assert.equal(c.balances.dtaGross, "132500.0000"); // the loss becomes a DTA
  const step = c.rateReconciliation.find((s) => s.key === "currentLossNotRecognized")!;
  assert.ok(step, "recon explains the floored current tax");
  // steps still sum to the total
  const stepsTotal = c.rateReconciliation
    .filter((s) => s.key !== "total")
    .reduce((a, s) => a + Number(s.amount), 0);
  assert.ok(Math.abs(stepsTotal - Number(c.totalExpense)) < 0.005, "reconciliation ties to total expense");
  assert.equal(c.effectiveRatePercent, "26.50", "loss-year benefit at the statutory rate is a negative expense over a negative base");
});

test("rate reconciliation steps sum to the total expense", () => {
  const c = buildProvision({
    pretaxBookIncome: "2400000",
    enactedRatePercent: RATE,
    permanentDifferences: [
      { description: "Fines", amount: "12000" },
      { description: "Tax-exempt interest", amount: "-30000" },
    ],
    lossCarryforwardUsed: "100000",
    valuationAllowance: "40000",
    differences: [
      { category: "fixed_assets", description: "P&E", difference: "300000", source: "auto" },
      { category: "provisions", description: "Warranty", difference: "-200000", source: "manual" },
    ],
    prior: { dtaGross: "0", dtlGross: "20000", valuationAllowance: "10000" },
  });
  const stepsTotal = c.rateReconciliation
    .filter((s) => s.key !== "total")
    .reduce((a, s) => a + Number(s.amount), 0);
  assert.ok(Math.abs(stepsTotal - Number(c.totalExpense)) < 0.005);
});
