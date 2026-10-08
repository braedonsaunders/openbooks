import assert from "node:assert/strict";
import test from "node:test";
import { payrollHourlyWage, salaryPeriodPay } from "./rate.ts";
import { divideMoney } from "./run-allocation.ts";

test("a salary pays the rate's annual amount over the schedule's periods, rounded once", () => {
  // A yearly rate pays exactly what it always has: rate ÷ periods per year.
  for (const periods of [12, 24, 26, 52]) {
    assert.equal(
      salaryPeriodPay({ basis: "year", rate: "88000.0000", annualHours: "2080" }, periods),
      divideMoney("88000.0000", String(periods), 2),
    );
  }
  // A monthly rate annualizes first: on a semimonthly schedule each period
  // pays half a month; on a biweekly schedule, a twenty-sixth of the year.
  const monthly = { basis: "month", rate: "6800", annualHours: "2080" } as const;
  assert.equal(salaryPeriodPay(monthly, 12), "6800.0000");
  assert.equal(salaryPeriodPay(monthly, 24), "3400.0000");
  assert.equal(salaryPeriodPay(monthly, 26), "3138.4600");
  assert.throws(
    () => salaryPeriodPay({ basis: "hour", rate: "32.5", annualHours: "2080" }, 26),
    /time-based rate/,
  );
});

test("the run's hourly wage converts every time-based cadence through the row's annual hours", () => {
  assert.equal(
    payrollHourlyWage({ basis: "year", rate: "91234.5678", annualHours: "1950.5" }),
    divideMoney("91234.5678", "1950.5", 4),
  );
  assert.equal(payrollHourlyWage({ basis: "hour", rate: "32.5000", annualHours: "2080" }), "32.5000");
  assert.equal(payrollHourlyWage({ basis: "month", rate: "6800", annualHours: "2080" }), "39.2308");
  assert.equal(payrollHourlyWage({ basis: "week", rate: "1500", annualHours: "2080" }), "37.5000");
});
