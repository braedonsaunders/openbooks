import assert from "node:assert/strict";
import test from "node:test";
import {
  LeavePayrollInputError,
  readLeavePayrollInputRow,
  requireBankedLeaveEntitlementPlan,
} from "../payroll/leave-payroll-inputs.ts";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  employeePartyId: "22222222-2222-4222-8222-222222222222",
  employmentId: "33333333-3333-4333-8333-333333333333",
  leaveTypeId: "55555555-5555-4555-8555-555555555555",
  kind: "bank_in",
  absenceDate: "2026-09-14",
  hours: "8.0000",
  sourceLeaveRequestId: "44444444-4444-4444-8444-444444444444",
  status: "pending",
  consumedByRunDocumentId: null,
  entitlementPlanId: null,
  entitlementMappingId: null,
  entitlementPlanUpdatedAt: null,
};

test("a stored input row reads into the typed contract for each declared kind and state", () => {
  assert.equal(readLeavePayrollInputRow(row).kind, "bank_in");
  assert.equal(
    readLeavePayrollInputRow({
      ...row,
      kind: "payout",
      status: "consumed",
      consumedByRunDocumentId: "r",
    }).kind,
    "payout",
  );
  assert.equal(readLeavePayrollInputRow({ ...row, status: "voided" }).status, "voided");
});

test("an unknown kind is refused by name, never priced as a payout", () => {
  // The fallthrough this replaces mapped anything that was not bank_in to
  // payout — money to the employee — so a third kind would have paid out silently.
  assert.throws(
    () => readLeavePayrollInputRow({ ...row, kind: "benefit_deduction" }),
    (error: unknown) =>
      error instanceof LeavePayrollInputError &&
      error.code === "REFUSED" &&
      /kind "benefit_deduction"/.test(error.message),
  );
  assert.throws(
    () => readLeavePayrollInputRow({ ...row, kind: undefined }),
    (error: unknown) => error instanceof LeavePayrollInputError && error.code === "REFUSED",
  );
});

test("an unknown status is refused by name", () => {
  assert.throws(
    () => readLeavePayrollInputRow({ ...row, status: "released" }),
    (error: unknown) =>
      error instanceof LeavePayrollInputError &&
      error.code === "REFUSED" &&
      /status "released"/.test(error.message),
  );
});

test("banked leave requires its explicit active hours plan and never defaults to vacation", () => {
  const mapping = {
    is_active: true,
    plan_id: "plan-1",
    unit: "hours",
    direction: "accrue",
    system_key: null,
    plan_active: true,
  };
  assert.deepEqual(
    requireBankedLeaveEntitlementPlan({
      absenceDate: "2026-09-14",
      mapping: { ...mapping, mapping_id: "mapping-1", plan_updated_at: "2026-09-01 00:00:00+00" },
    }),
    { planId: "plan-1", mappingId: "mapping-1", planUpdatedAt: "2026-09-01 00:00:00+00" },
  );
  for (const invalid of [
    undefined,
    { ...mapping, is_active: false },
    { ...mapping, plan_active: false },
    { ...mapping, unit: "money" },
    { ...mapping, direction: "owe" },
    { ...mapping, system_key: "vacation" },
  ]) {
    assert.throws(
      () =>
        requireBankedLeaveEntitlementPlan({
          absenceDate: "2026-09-14",
          mapping: invalid && {
            ...invalid,
            mapping_id: "mapping-1",
            plan_updated_at: "2026-09-01 00:00:00+00",
          },
        }),
      (error: unknown) =>
        error instanceof LeavePayrollInputError &&
        /effective entitlement mapping/.test(error.message),
    );
  }
});
