import assert from "node:assert/strict";
import test from "node:test";
import { priceLeavePayrollInputs } from "./leave-payroll-effects.ts";
import { LeavePayrollInputError, type LeavePayrollInput } from "./leave-payroll-inputs.ts";

const input = (overrides: Partial<LeavePayrollInput>): LeavePayrollInput => ({
  id: "input-1",
  employeePartyId: "employee-1",
  employmentId: "employment-1",
  leaveTypeId: "leave-type-1",
  kind: "payout",
  absenceDate: "2026-09-14",
  hours: "8.00",
  sourceLeaveRequestId: "request-1",
  status: "consumed",
  consumedByRunDocumentId: "run-1",
  entitlementPlanId: null,
  entitlementMappingId: null,
  entitlementPlanUpdatedAt: null,
  ...overrides,
});

test("leave payout uses exact wage multiplication and bank-in consolidates by mapped plan", () => {
  const result = priceLeavePayrollInputs(
    [
      input({ hours: "2.50" }),
      input({ id: "input-2", kind: "bank_in", hours: "3.25", entitlementPlanId: "plan-1" }),
      input({ id: "input-3", kind: "bank_in", hours: "4.75", entitlementPlanId: "plan-1" }),
      input({ id: "input-4", kind: "bank_in", hours: "1.50", entitlementPlanId: "plan-2" }),
    ],
    "26.375",
  );
  assert.deepEqual(
    result.payouts.map(({ amount }) => amount),
    ["65.9375"],
  );
  assert.deepEqual(result.bankIns, [
    { planId: "plan-1", hours: "8.0000" },
    { planId: "plan-2", hours: "1.5000" },
  ]);
});

test("payout and banked leave refuse missing wage or mapped plan", () => {
  assert.throws(
    () => priceLeavePayrollInputs([input({})], null),
    (error: unknown) =>
      error instanceof LeavePayrollInputError && /effective wage rate/.test(error.message),
  );
  assert.throws(
    () => priceLeavePayrollInputs([input({ kind: "bank_in" })], "26.00"),
    (error: unknown) =>
      error instanceof LeavePayrollInputError &&
      /effective entitlement mapping/.test(error.message),
  );
});
