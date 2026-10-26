import assert from "node:assert/strict";
import test from "node:test";
import { parseMoney } from "../money/brands.ts";
import { scheduledSalaryEarning } from "./benefit-plan-inputs.ts";
import type { Line } from "./run-stub-records.ts";
const line = (componentId: string, description: string, amount = "1000"): Line => ({
  componentId,
  kind: "earning",
  description,
  amount: parseMoney(amount),
  sequence: 10,
});
test("scheduled salary uses the base-pay identity after a replacement or description rename", () => {
  const salary = line("base", "Approved salary replacement"),
    misleading = line("allowance", "Salary");
  assert.equal(scheduledSalaryEarning([misleading, salary], "base", "PENSION"), salary);
  const renamed = { ...salary, description: "Salaire" };
  assert.equal(scheduledSalaryEarning([renamed], "base", "PENSION"), renamed);
  assert.equal(salary.hours, undefined, "selection preserves retained salary facts");
});
test("a misleading label or ambiguous paid base cannot create scheduled service hours", () => {
  for (const lines of [
    [line("allowance", "Salary")],
    [line("base", "Salary", "0")],
    [line("base", "Salary", "-100")],
    [line("base", "First base payment"), line("base", "Second base payment")],
  ])
    assert.throws(
      () => scheduledSalaryEarning(lines, "base", "PENSION"),
      /one positive native base-pay salary earning/,
    );
});
