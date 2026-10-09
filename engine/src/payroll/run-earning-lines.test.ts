import assert from "node:assert/strict";
import test from "node:test";
import { applyRunLineAdjustments } from "./run-earning-lines.ts";
import { totalHours, type Line } from "./run-stub-records.ts";
import { parseMoney } from "../money/brands.ts";
import { sum } from "../money/money.ts";

const componentId = "0e0cadb6-49d5-4f4c-a445-b8570985438f";
const row = (values: Record<string, unknown> = {}) => ({
  id: componentId, adjustment_id: "025a65f5-0515-4f0b-a703-9a96317a82ba",
  name: "Paid salary hours", kind: "earning", unit_of_measure: "hours",
  adj_amount: "0.0000", adj_hours: "32.50", sequence: 10, is_active: true,
  payment_kind: "cash", taxable: false, pensionable: false, insurable: true,
  vacationable: false, non_periodic: false, ...values,
});

async function apply(rows: Record<string, unknown>[], lines: Line[] = []) {
  // Database reads are the boundary; native line construction and arithmetic
  // run unchanged, including the bank-input guard.
  const tx = { execute: async () => ({ rows }) } as unknown as Parameters<typeof applyRunLineAdjustments>[0];
  const replaced = await applyRunLineAdjustments(tx, {
    orgId: "b3d89b81-95bd-405d-b2ee-e75a4602bd43",
    documentId: "3f429ce4-dc08-4b6b-a3f3-60250c9b82e1",
    employeePartyId: "af97e77d-58d5-4388-957c-bc8b11da30a7",
    bonusRun: false, retroRun: false, terminationRun: false, country: "CA", lines,
  });
  return { lines, replaced };
}

test("paid-hour adjustments retain their basis without adding cash earnings", async () => {
  const salary: Line = { componentId: null, kind: "earning", description: "Salary",
    amount: parseMoney("1888"), sequence: 1 };
  const { lines } = await apply([row()], [salary]);
  assert.equal(lines.length, 2);
  assert.equal(totalHours(lines), "32.5000");
  assert.equal(sum(lines.map(line => line.amount)), "1888.0000");
  assert.equal(lines[1]!.insurable, true);
  assert.equal(lines[1]!.vacationable, false);
  assert.equal(lines[1]!.runAdjustmentId, row().adjustment_id);
});

test("zero replacements still suppress pay without retaining empty or quantity lines", async () => {
  for (const values of [{ adj_hours: null }, { adj_hours: "0" },
    { unit_of_measure: "quantity" }, { kind: "deduction" }, { kind: "employer_contribution" }]) {
    const original: Line = { componentId, kind: "earning", description: "Salary",
      amount: parseMoney("1888"), hours: "40", sequence: 1 };
    const { lines, replaced } = await apply([row({ ...values, replace_component: true })], [original]);
    assert.equal(lines.length, 0);
    assert.deepEqual([...replaced], [componentId]);
  }
});

test("cash quantity adjustments retain money and exclude units from paid hours", async () => {
  const { lines } = await apply([row({ unit_of_measure: "quantity", adj_amount: "150", adj_hours: "3" })]);
  assert.equal(totalHours(lines), "0.0000");
  assert.equal(sum(lines.map(line => line.amount)), "150.0000");
  assert.equal(lines[0]!.hours, undefined);
});
