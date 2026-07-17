import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBudgetVariance,
  classifyPeriodPerformance,
  classifyUnmatchedBankActivity,
  nextContinuousCloseRunAt,
} from "./continuous-close.ts";

test("unmatched bank activity escalates for age, count, or exact materiality", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  assert.equal(classifyUnmatchedBankActivity({
    materiality: "4999.9999",
    threshold: "1000.0000",
    oldestDate: "2026-07-15",
    count: 1,
    now,
  }), "warning");
  assert.equal(classifyUnmatchedBankActivity({
    materiality: "5000.0000",
    threshold: "1000.0000",
    oldestDate: "2026-07-15",
    count: 1,
    now,
  }), "critical");
  assert.equal(classifyUnmatchedBankActivity({
    materiality: "0.0000",
    threshold: "1000.0000",
    oldestDate: "2026-06-16",
    count: 1,
    now,
  }), "critical");
  assert.equal(classifyUnmatchedBankActivity({
    materiality: "0.0000",
    threshold: "1000.0000",
    oldestDate: "2026-07-16",
    count: 50,
    now,
  }), "critical");
});

test("budget variance respects account signs, ten-percent floor, and exact money", () => {
  const incomeMiss = classifyBudgetVariance({
    budget: "1000.0000",
    actual: "899.9999",
    accountType: "income",
    threshold: "100.0000",
  });
  assert.deepEqual(incomeMiss, {
    include: true,
    favorable: false,
    variance: "-100.0001",
    varianceBps: 1000,
    severity: "warning",
  });

  const incomeBeat = classifyBudgetVariance({
    budget: "1000.0000",
    actual: "1300.0000",
    accountType: "income",
    threshold: "100.0000",
  });
  assert.equal(incomeBeat.favorable, true);
  assert.equal(incomeBeat.include, false);

  const expenseOverrun = classifyBudgetVariance({
    budget: "1000.0000",
    actual: "1250.0000",
    accountType: "expense",
    threshold: "100.0000",
  });
  assert.equal(expenseOverrun.favorable, false);
  assert.equal(expenseOverrun.include, true);
  assert.equal(expenseOverrun.varianceBps, 2500);
  assert.equal(expenseOverrun.severity, "critical");

  const belowMateriality = classifyBudgetVariance({
    budget: "1000.0000",
    actual: "1100.0000",
    accountType: "expense",
    threshold: "100.0001",
  });
  assert.equal(belowMateriality.include, false);
});

test("period performance detects exact revenue and gross-margin deterioration", () => {
  const result = classifyPeriodPerformance({
    currentRevenue: "800.0000",
    priorRevenue: "1000.0000",
    currentCogs: "450.0000",
    priorCogs: "400.0000",
    threshold: "200.0000",
  });
  assert.deepEqual(result, {
    revenueDecline: true,
    revenueChangeBps: -2000,
    grossMarginDropBps: 1625,
  });

  assert.equal(classifyPeriodPerformance({
    currentRevenue: "900.0000",
    priorRevenue: "1000.0000",
    currentCogs: "400.0000",
    priorCogs: "400.0000",
    threshold: "100.0001",
  }).revenueDecline, false);
});

test("agent schedules advance in UTC without local-time drift", () => {
  const from = new Date("2026-03-08T06:30:00.000Z");
  assert.equal(nextContinuousCloseRunAt("daily", from).toISOString(), "2026-03-09T06:30:00.000Z");
  assert.equal(nextContinuousCloseRunAt("weekly", from).toISOString(), "2026-03-15T06:30:00.000Z");
});
