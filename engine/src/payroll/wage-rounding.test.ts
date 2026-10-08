import assert from "node:assert/strict";
import test from "node:test";
import { sum } from "../money/money.ts";
import { requirePayrollWageRounding } from "../projects/payroll-wage-rounding.ts";
import { priceDatedWageEntries } from "./wage-rounding.ts";

const entries = (hours: readonly string[]) => hours.map((value, index) => ({ hours: value, workedOn: `2026-07-${String(13 + index).padStart(2, "0")}` }));
const total = (rate: string, multiplier: string, hours: readonly string[], scale: number, scope: "time_entry" | "dimension_group") =>
  sum(priceDatedWageEntries(rate, multiplier, entries(hours), { payrollRateScale: scale, payrollAmountRounding: scope }).days.map((day) => day.amount));

test("multiplied rate precision and entry amount rounding are independent wage terms", () => {
  // Five half-hour and one-hour entries have half-cent monetary boundaries,
  // while the 35.25 overtime rate independently has a third decimal place.
  assert.equal(total("31.50", "1.5", ["0.5", "0.5", "0.5", "1.5", "1"], 4, "dimension_group"), "189.0000");
  assert.equal(total("31.50", "1.5", ["0.5", "0.5", "0.5", "1.5", "1"], 4, "time_entry"), "189.0200");
  assert.equal(total("35.25", "1.5", ["1", "1", "1.5", "0.5", "1"], 4, "dimension_group"), "264.3800");
  assert.equal(total("35.25", "1.5", ["1", "1", "1.5", "0.5", "1"], 2, "time_entry"), "264.4000");
});

test("entry rounding retains distinct entries on one day and conserves signed hours", () => {
  const priced = priceDatedWageEntries("33.25", "1", [
    { workedOn: "2026-05-19", hours: "4.5" }, { workedOn: "2026-05-19", hours: "6.5" },
    { workedOn: "2026-05-20", hours: "8" }, { workedOn: "2026-05-21", hours: "8" },
  ], { payrollRateScale: 2, payrollAmountRounding: "time_entry" });
  assert.equal(sum(priced.days.map((day) => day.hours)), "27.0000");
  assert.equal(sum(priced.days.map((day) => day.amount)), "897.7600");
  assert.equal(priced.days[0]!.amount, "365.7600", "same-day entries must not be repriced as one aggregate");
  assert.equal(total("47.25", "1", ["0.5", "-0.5", "0"], 2, "time_entry"), "0.0000");
  assert.deepEqual(priceDatedWageEntries("33.25", "1", entries(["0"]),
    { payrollRateScale: 4, payrollAmountRounding: "dimension_group" }).days, [], "the existing zero-weight group emits no wages");
});

test("unknown or out-of-range wage rounding terms refuse with the actual authoring remedy", () => {
  for (const scale of [-1, 5, 1.5, "2", null, undefined]) {
    assert.throws(() => requirePayrollWageRounding(scale, "time_entry"), /integer from 0 through 4.*dated wage record/);
  }
  assert.throws(() => requirePayrollWageRounding(2, "day"), /dimension_group or time_entry.*dated wage record/);
});
