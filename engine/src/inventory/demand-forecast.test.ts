import assert from "node:assert/strict";
import test from "node:test";
import {
  averageDemandInterval,
  decimalStd,
  forecastDemand,
  imputeStockouts,
  isIntermittentDemand,
  measurePromotionLift,
  roundedSqrtUnits,
  zForServiceLevel,
  type DemandWeek,
} from "./demand-forecast.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { cmp } from "../money/money.ts";

const MONDAY = "2025-01-06";

function weeklySeries(quantities: readonly (string | number)[], stockouts: readonly number[] = []): DemandWeek[] {
  return quantities.map((quantity, index) => ({
    weekStart: addCalendarDays(MONDAY, index * 7),
    quantity: String(quantity),
    stockout: stockouts.includes(index),
  }));
}

function within(value: string, low: string, high: string): boolean {
  return cmp(value, low) >= 0 && cmp(value, high) <= 0;
}

test("a stockout zero is imputed from its neighbours instead of dragging the forecast", () => {
  const weeks = weeklySeries([10, 10, 10, 0, 10, 10, 10, 10], [3]);
  const { corrected, imputed } = imputeStockouts(weeks);
  assert.equal(corrected[3], "10.0000");
  assert.deepEqual(imputed, [weeks[3]!.weekStart]);
  const result = forecastDemand(weeks, { horizonWeeks: 2 });
  for (const period of result.periods) {
    assert.ok(within(period.quantity, "9", "11"), `forecast ${period.quantity} near 10`);
  }
  assert.deepEqual(result.explanation.stockoutWeeksImputed, [weeks[3]!.weekStart]);
});

test("an annual seasonal series forecasts the seasonal shape within tolerance", () => {
  const quantities: number[] = [];
  for (let index = 0; index < 104; index++) {
    const phase = index % 52;
    quantities.push(phase >= 44 && phase <= 47 ? 160 : 100);
  }
  const result = forecastDemand(weeklySeries(quantities), { horizonWeeks: 4 });
  assert.ok(
    result.explanation.method === "seasonal_additive" || result.explanation.method === "seasonal_multiplicative",
    `expected a seasonal method, got ${result.explanation.method}`,
  );
  // Weeks 104-107 sit outside the peak: the forecast must see the shape.
  for (const period of result.periods) {
    assert.ok(within(period.quantity, "85", "115"), `off-peak forecast ${period.quantity} near 100`);
  }
  assert.equal(result.explanation.seasonalPeakMonth, 11);
});

test("a sparse intermittent series forecasts with Croston/SBA", () => {
  const quantities: number[] = Array.from({ length: 40 }, (_, index) => (index % 4 === 0 ? 20 : 0));
  assert.equal(isIntermittentDemand(quantities.map(String)), true);
  const result = forecastDemand(weeklySeries(quantities), { horizonWeeks: 2 });
  assert.equal(result.explanation.method, "croston_sba");
  assert.equal(result.periods[0]!.method, "croston_sba");
  // Croston rate 20/4 with the SBA (1 − α/2) correction: below the naive mean.
  assert.ok(within(result.periods[0]!.quantity, "3", "5"), `croston level ${result.periods[0]!.quantity}`);
});

test("steady demand is not intermittent and averages flat", () => {
  const quantities = Array.from({ length: 20 }, () => 12);
  assert.equal(isIntermittentDemand(quantities.map(String)), false);
  const result = forecastDemand(weeklySeries(quantities), { horizonWeeks: 3 });
  assert.equal(result.explanation.method, "moving_average");
  for (const period of result.periods) {
    assert.equal(period.quantity, "12.0000");
    assert.equal(period.lower, period.upper);
  }
});

test("a measured promotion lift de-promotes history and uplifts planned promo weeks", () => {
  const quantities: number[] = Array.from({ length: 20 }, (_, index) =>
    index === 8 || index === 9 || index === 14 || index === 15 ? 13 : 10,
  );
  const weeks = weeklySeries(quantities);
  const windows = [{ code: "SPRING", startsOn: weeks[8]!.weekStart, endsOn: addCalendarDays(weeks[9]!.weekStart, 6) },
    { code: "SPRING", startsOn: weeks[14]!.weekStart, endsOn: addCalendarDays(weeks[15]!.weekStart, 6) }];
  const result = forecastDemand(weeks, { horizonWeeks: 4, promotionWindows: windows });
  assert.equal(result.explanation.promotionCode, "SPRING");
  assert.ok(
    within(result.explanation.promotionLiftFactor!, "1.25", "1.35"),
    `lift ${result.explanation.promotionLiftFactor} near 1.3`,
  );
  // History is de-promoted before fitting: the base forecast stays near 10.
  assert.ok(within(result.periods[0]!.quantity, "9", "11"), `base forecast ${result.periods[0]!.quantity}`);
  const uplifted = forecastDemand(weeks, {
    horizonWeeks: 4,
    promotionWindows: windows,
    plannedPromotionWeeks: [result.periods[1]!.periodStart],
  });
  assert.ok(
    cmp(uplifted.periods[1]!.quantity, result.periods[1]!.quantity) > 0,
    "a planned promotion week forecasts above the base",
  );
});

test("promotion windows too thin to measure are ignored with a reason", () => {
  const weeks = weeklySeries(Array.from({ length: 10 }, () => 10));
  const lift = measurePromotionLift(
    weeks.map((week) => week.weekStart),
    weeks.map((week) => week.quantity),
    [{ code: "ONE", startsOn: weeks[2]!.weekStart, endsOn: addCalendarDays(weeks[2]!.weekStart, 6) }],
  );
  assert.equal(lift.factor, null);
  assert.match(lift.ignoredReason!, /fewer than two/);
});

test("service-level z matches the standard normal table", () => {
  assert.equal(zForServiceLevel("0.5"), "0.0000");
  assert.equal(zForServiceLevel("0.95"), "1.6449");
  assert.equal(zForServiceLevel("0.99"), "2.3263");
  const between = zForServiceLevel("0.925");
  assert.ok(within(between, "1.2816", "1.6449"), `interpolated z ${between}`);
});

test("exact decimal statistics never cross floating point", () => {
  assert.equal(decimalStd(["2", "2", "2"]), "0.0000");
  assert.equal(decimalStd(["0", "4"]), "2.0000");
  assert.equal(roundedSqrtUnits(4n * 10_000n * 10_000n).toString(), "20000");
  assert.equal(averageDemandInterval(["5", "0", "0", "5", "0", "0", "5"]), "3.0000");
});

test("an empty history is refused instead of forecasting zero", () => {
  assert.throws(() => forecastDemand([], { horizonWeeks: 4 }), /at least one week/);
});

test("a pinned average method skips the seasonal race on short history", () => {
  const quantities = [10, 11, 9, 10, 12, 10];
  const result = forecastDemand(weeklySeries(quantities), { horizonWeeks: 2, method: "average" });
  assert.equal(result.explanation.method, "moving_average");
  assert.equal(result.explanation.holdoutWeeks, 0);
});
