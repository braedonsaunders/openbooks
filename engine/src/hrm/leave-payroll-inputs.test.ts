import assert from "node:assert/strict";
import test from "node:test";
import { LeaveError } from "./leave-errors.ts";
import { readLeavePayrollInputRow } from "./leave-payroll-inputs.ts";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  employeePartyId: "22222222-2222-4222-8222-222222222222",
  employmentId: "33333333-3333-4333-8333-333333333333",
  kind: "bank_in",
  absenceDate: "2026-09-14",
  hours: "8.0000",
  sourceLeaveRequestId: "44444444-4444-4444-8444-444444444444",
  status: "pending",
  consumedByRunDocumentId: null,
};

test("a stored input row reads into the typed contract for each declared kind and state", () => {
  assert.equal(readLeavePayrollInputRow(row).kind, "bank_in");
  assert.equal(readLeavePayrollInputRow({ ...row, kind: "payout", status: "consumed", consumedByRunDocumentId: "r" }).kind, "payout");
  assert.equal(readLeavePayrollInputRow({ ...row, status: "voided" }).status, "voided");
});

test("an unknown kind is refused by name, never priced as a payout", () => {
  // The fallthrough this replaces mapped anything that was not bank_in to
  // payout — money to the employee — so a third kind would have paid out silently.
  assert.throws(
    () => readLeavePayrollInputRow({ ...row, kind: "benefit_deduction" }),
    (error: unknown) => error instanceof LeaveError && error.code === "REFUSED" && /kind "benefit_deduction"/.test(error.message),
  );
  assert.throws(
    () => readLeavePayrollInputRow({ ...row, kind: undefined }),
    (error: unknown) => error instanceof LeaveError && error.code === "REFUSED",
  );
});

test("an unknown status is refused by name", () => {
  assert.throws(
    () => readLeavePayrollInputRow({ ...row, status: "released" }),
    (error: unknown) => error instanceof LeaveError && error.code === "REFUSED" && /status "released"/.test(error.message),
  );
});
