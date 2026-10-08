import assert from "node:assert/strict";
import test from "node:test";
import {
  computeTaskEarnedValue,
  rollUpProjectEarnedValue,
  suggestTaskForecasts,
  type TaskEarnedValueInput,
} from "./earned-value-math.ts";

const task = (overrides: Partial<TaskEarnedValueInput> = {}): TaskEarnedValueInput => ({
  taskId: "t1",
  code: "100",
  name: "Conduit",
  budgetCost: "1000.0000",
  budgetHours: "40.0000",
  budgetQuantity: null,
  budgetUnit: null,
  installedQuantity: "0",
  scheduleProgress: null,
  actualCost: "0",
  actualHours: "0",
  trailingCost: "0",
  trailingHours: "0",
  forecast: null,
  ...overrides,
});

test("installed quantity governs percent complete and earned value, capped at the budget", () => {
  const partial = computeTaskEarnedValue(task({
    budgetQuantity: "100.00000000", budgetUnit: "m", installedQuantity: "25.00000000",
    actualCost: "300.0000", actualHours: "10.0000",
  }));
  assert.equal(partial.basis, "quantity");
  assert.equal(partial.percentComplete, "25.0000");
  assert.equal(partial.earnedValue, "250.0000");
  assert.equal(partial.costPerformanceIndex, "0.8333");
  assert.equal(partial.productivity, "2.5000");

  const overrun = computeTaskEarnedValue(task({ budgetQuantity: "100", budgetUnit: "m", installedQuantity: "120" }));
  assert.equal(overrun.percentComplete, "100.0000");
  assert.equal(overrun.earnedValue, "1000.0000");
  assert.equal(overrun.installedQuantity, "120.00000000");
});

test("without quantities, schedule progress then cost-to-cost measures completion", () => {
  const scheduled = computeTaskEarnedValue(task({ scheduleProgress: "0.4000", actualCost: "100" }));
  assert.equal(scheduled.basis, "schedule");
  assert.equal(scheduled.percentComplete, "40.0000");
  assert.equal(scheduled.earnedValue, "400.0000");

  // Cost-to-cost is capped at 100%: an overrun earns the budget, not more.
  const costed = computeTaskEarnedValue(task({ actualCost: "1200.0000" }));
  assert.equal(costed.basis, "cost");
  assert.equal(costed.percentComplete, "100.0000");
  assert.equal(costed.earnedValue, "1000.0000");
  assert.equal(costed.estimateToComplete, "0.0000");
  assert.equal(costed.estimateAtCompletion, "1200.0000");
  assert.equal(costed.varianceAtCompletion, "-200.0000");
});

test("a task with no budget is unmeasured and its ratios are null, never zero-division", () => {
  const unmeasured = computeTaskEarnedValue(task({ budgetCost: null, budgetHours: null }));
  assert.equal(unmeasured.basis, "none");
  assert.equal(unmeasured.percentComplete, null);
  assert.equal(unmeasured.earnedValue, "0.0000");
  assert.equal(unmeasured.costPerformanceIndex, null);
  assert.equal(unmeasured.hoursToComplete, null);
  assert.equal(unmeasured.productivity, null);
  assert.equal(unmeasured.weeksToComplete, "0.00");
});

test("exact rounding happens once at the declared scale", () => {
  const third = computeTaskEarnedValue(task({ budgetCost: "100", budgetQuantity: "3", budgetUnit: "ea", installedQuantity: "1" }));
  assert.equal(third.percentComplete, "33.3333");
  assert.equal(third.earnedValue, "33.3333");
  // Two thirds rounds half away from zero at the money scale.
  const twoThirds = computeTaskEarnedValue(task({ budgetCost: "100", budgetQuantity: "3", budgetUnit: "ea", installedQuantity: "2" }));
  assert.equal(twoThirds.earnedValue, "66.6667");
});

test("the latest forecast replaces the remaining budget as the estimate to complete", () => {
  const base = { actualCost: "600.0000", actualHours: "30.0000", trailingCost: "400.0000", trailingHours: "20.0000" };
  const fallback = computeTaskEarnedValue(task(base));
  assert.equal(fallback.estimateSource, "remaining_budget");
  assert.equal(fallback.estimateToComplete, "400.0000");
  assert.equal(fallback.hoursToComplete, "10.0000");
  assert.equal(fallback.weeklyCostBurn, "100.0000");
  assert.equal(fallback.weeklyHoursBurn, "5.0000");
  assert.equal(fallback.weeksToComplete, "4.00");

  const forecast = computeTaskEarnedValue(task({
    ...base,
    forecast: { method: "manual", asOfDate: "2026-06-30", costToComplete: "900.0000", hoursToComplete: "50" },
  }));
  assert.equal(forecast.estimateSource, "forecast");
  assert.equal(forecast.estimateAtCompletion, "1500.0000");
  assert.equal(forecast.varianceAtCompletion, "-500.0000");
  assert.equal(forecast.hoursToComplete, "50.0000");
  assert.equal(forecast.weeksToComplete, "9.00");

  const idle = computeTaskEarnedValue(task({ actualCost: "100" }));
  assert.equal(idle.weeksToComplete, null, "no burn in the window means no projection");
});

test("suggestions offer each method only where it has a basis", () => {
  const measured = task({
    budgetQuantity: "100", budgetUnit: "m", installedQuantity: "25",
    actualCost: "200.0000", actualHours: "10.0000",
  });
  const byMethod = Object.fromEntries(suggestTaskForecasts(measured).map((s) => [s.method, s]));
  assert.deepEqual(byMethod.remaining_budget, { method: "remaining_budget", costToComplete: "800.0000", hoursToComplete: "30.0000" });
  // 75 m left at 8.00 per installed metre; 0.4 hours per metre.
  assert.deepEqual(byMethod.units_productivity, { method: "units_productivity", costToComplete: "600.0000", hoursToComplete: "30.0000" });
  // (1000 − 250) ÷ CPI 1.25.
  assert.equal(byMethod.cost_performance?.costToComplete, "600.0000");

  const nothingInstalled = suggestTaskForecasts(task({ budgetQuantity: "100", budgetUnit: "m" }));
  assert.deepEqual(nothingInstalled.map((s) => s.method), ["remaining_budget"]);

  // Cost performance needs a positive CPI; schedule-based EV supplies one here.
  const scheduled = suggestTaskForecasts(task({ scheduleProgress: "0.5", actualCost: "800" }));
  assert.equal(scheduled.find((s) => s.method === "cost_performance")?.costToComplete, "800.0000");
});

test("project roll-up counts unassigned cost in AC, CPI and EAC but earns nothing for it", () => {
  const tasks = [
    computeTaskEarnedValue(task({ taskId: "a", budgetQuantity: "10", budgetUnit: "ea", installedQuantity: "5", actualCost: "400" })),
    computeTaskEarnedValue(task({ taskId: "b", budgetCost: "500", actualCost: "100", scheduleProgress: "0.2" })),
  ];
  const totals = rollUpProjectEarnedValue(tasks, {
    actualCost: "100", actualHours: "4", trailingCost: "40", trailingHours: "0",
  });
  assert.equal(totals.budgetAtCompletion, "1500.0000");
  assert.equal(totals.earnedValue, "600.0000");
  assert.equal(totals.actualCost, "600.0000");
  assert.equal(totals.unassignedActualCost, "100.0000");
  assert.equal(totals.costPerformanceIndex, "1.0000");
  assert.equal(totals.percentComplete, "40.0000");
  // ETC: (1000 − 400) + (500 − 100) = 1000; EAC = 600 + 1000.
  assert.equal(totals.estimateToComplete, "1000.0000");
  assert.equal(totals.estimateAtCompletion, "1600.0000");
  assert.equal(totals.varianceAtCompletion, "-100.0000");
  assert.equal(totals.weeklyCostBurn, "10.0000");
  assert.equal(totals.weeksToComplete, "100.00");
});
