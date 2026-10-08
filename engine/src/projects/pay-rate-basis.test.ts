import assert from "node:assert/strict";
import test from "node:test";
import { div } from "../money/money.ts";
import { annualPayRate, hourlyPayRate, payRateIn, requirePayRateBasis } from "./pay-rate-basis.ts";

test("a yearly rate converts to hourly exactly as rate ÷ annual hours", () => {
  for (const [rate, hours] of [["88000.0000", "2080"], ["91234.5678", "1950.5"], ["0", "2080"]] as const) {
    assert.equal(hourlyPayRate(rate, "year", hours), div(rate, hours));
  }
  assert.equal(hourlyPayRate("32.5000", "hour", "2080"), "32.5000", "an hourly rate is returned unchanged");
});

test("time-based cadences annualize through their periods per year", () => {
  assert.equal(annualPayRate("1450", "week", "2080"), "75400.0000");
  assert.equal(annualPayRate("2900", "biweekly", "2080"), "75400.0000");
  assert.equal(annualPayRate("3141.6667", "semimonth", "2080"), "75400.0008");
  assert.equal(annualPayRate("6800", "month", "2080"), "81600.0000");
  assert.equal(annualPayRate("88000", "year", "2080"), "88000.0000");
  // The hourly wage divides the annual amount by the row's annual hours.
  assert.equal(hourlyPayRate("6800", "month", "2080"), div("81600", "2080"));
  assert.equal(hourlyPayRate("1450", "week", "2000"), "37.7000");
});

test("restating a whole-number monthly rate as yearly and back is exact", () => {
  const yearly = payRateIn("6800", "month", "year", "2080");
  assert.equal(yearly, "81600.0000");
  assert.equal(payRateIn(yearly, "year", "month", "2080"), "6800.0000");
});

test("an hourly rate annualizes through annual hours, which must be positive", () => {
  assert.equal(payRateIn("32.5", "hour", "year", "1950"), "63375.0000");
  for (const hours of ["0", "-2080"]) {
    assert.throws(() => hourlyPayRate("88000", "year", hours), /annual hours must be greater than zero/);
    assert.throws(() => annualPayRate("32.5", "hour", hours), /annual hours must be greater than zero/);
  }
  assert.throws(() => requirePayRateBasis("monthly"), /not a supported pay cadence/);
});
