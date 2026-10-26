import assert from "node:assert/strict";
import test from "node:test";
import { parseMoney } from "../money/brands.ts";
import {
  priceAllowancePayrollInputs,
  type AllowancePayrollInput,
} from "./allowance-payroll-inputs.ts";

function input(overrides: Partial<AllowancePayrollInput> = {}): AllowancePayrollInput {
  return {
    id: "input-a",
    entryKind: "per_diem",
    entryId: "entry-a",
    employmentId: "employment-a",
    employeePartyId: "employee-a",
    payComponentId: "component-a",
    amount: parseMoney("125.3750"),
    currency: "CAD",
    coverageDate: "2026-10-01",
    status: "consumed",
    consumedByRunDocumentId: "run-a",
    ...overrides,
  };
}

test("approved allowance amounts become exact component earnings on their coverage date", () => {
  assert.deepEqual(priceAllowancePayrollInputs([input()], "CAD"), [
    {
      id: "input-a",
      entryKind: "per_diem",
      payComponentId: "component-a",
      amount: "125.3750",
      coverageDate: "2026-10-01",
    },
  ]);
});

test("an allowance currency mismatch refuses instead of silently converting or paying", () => {
  assert.throws(
    () => priceAllowancePayrollInputs([input({ currency: "USD" })], "CAD"),
    /is in USD, but this pay run pays CAD.*update the policy currency.*void, recompute and approve/,
  );
});

test("missing pay-run currency refuses approved allowance inputs", () => {
  assert.throws(
    () => priceAllowancePayrollInputs([input()], ""),
    /pay run has no valid currency.*set the payroll document currency/,
  );
});
