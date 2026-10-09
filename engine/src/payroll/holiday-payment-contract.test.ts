import test from "node:test";
import assert from "node:assert/strict";
import { readAdjudicatedHolidayPayment, priceAdjudicatedHolidayPayment } from "./holiday-payment-contract.ts";

const instruction = {
  employeePartyId: "10000000-0000-4000-8000-000000000001",
  holidayDates: ["2026-01-01", "2025-12-26", "2025-12-25"],
  hours: "24", assessedOn: "2026-01-10", wageBasisDate: "2026-01-10", paymentDate: "2026-01-16",
  instructionKey: "holiday-pay-2026-01", sourceReference: "Approved unpaid holiday entitlement",
  sourceDigest: "a".repeat(64),
};
const hourly = { rate: "45", basis: "hour" as const, annualHours: "2080", payrollRateScale: 2, payrollAmountRounding: "time_entry" as const };

test("adjudicated holiday hours retain every source date without inventing a daily allocation", () => {
  const read = readAdjudicatedHolidayPayment(instruction);
  assert.deepEqual(read.holidayDates, ["2025-12-25", "2025-12-26", "2026-01-01"]);
  assert.equal(read.hours, "24.00");
  assert.deepEqual(instruction.holidayDates, ["2026-01-01", "2025-12-26", "2025-12-25"]);
  assert.equal(readAdjudicatedHolidayPayment({ ...instruction, employeePartyId: "ABCDEF12-0000-4000-8000-000000000001" }).employeePartyId, "abcdef12-0000-4000-8000-000000000001");
  assert.deepEqual(priceAdjudicatedHolidayPayment(read, hourly), { hours: "24.00", rate: "45.0000", amount: "1080.0000" });
});

test("holiday payment refuses cash fitting and incomplete or contradictory source evidence", () => {
  for (const changes of [
    { amount: "1080" }, { holidayDates: [] }, { holidayDates: ["2026-01-01", "2026-01-01"] },
    { holidayDates: ["2026-02-30"] }, { holidayDates: ["2026-01-16"] },
    { assessedOn: "2026-01-17" }, { wageBasisDate: "2026-01-17" },
    { employeePartyId: "unknown" }, { sourceDigest: "unverified" }, { instructionKey: " " },
    { sourceReference: " " }, { hours: "0" }, { hours: "-1" }, { hours: "0.001" },
    { hours: "1e1" }, { hours: "1,000" }, { hours: 24 }, { hours: "10000000000" },
  ]) assert.throws(() => readAdjudicatedHolidayPayment({ ...instruction, ...changes }), undefined, JSON.stringify(changes));
});

test("holiday pricing uses the native wage cadence and declared rate precision", () => {
  const read = readAdjudicatedHolidayPayment({ ...instruction, hours: "1.5" });
  assert.equal(priceAdjudicatedHolidayPayment(read, { ...hourly, rate: "123500", basis: "year", annualHours: "2080" }).amount, "89.0700");
  const fractional = { ...hourly, rate: "45.5555" };
  assert.equal(priceAdjudicatedHolidayPayment(read, fractional).amount, "68.3400");
  assert.equal(priceAdjudicatedHolidayPayment(read, { ...fractional, payrollRateScale: 4 }).amount, "68.3300");
  assert.equal(priceAdjudicatedHolidayPayment(read, { ...hourly, annualHours: "0" }).amount, "67.5000");
  for (const changes of [{ rate: "0" }, { rate: "1e3" }, { rate: "NaN" }, { basis: "year", annualHours: "0" }, { payrollRateScale: 5 }]) {
    assert.throws(() => priceAdjudicatedHolidayPayment(read, { ...hourly, ...changes } as typeof hourly));
  }
  assert.throws(() => priceAdjudicatedHolidayPayment(read, { ...hourly, rate: "9999999999999999" }), /amount column/);
});
