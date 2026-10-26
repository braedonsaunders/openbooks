import assert from "node:assert/strict";
import test from "node:test";
import {
  declaredVacationAccrualEvidence,
  isDeclaredVacationAccrualInput,
  parseDeclaredVacationAccrualEvidence,
} from "./run-vacation-accrual-input.ts";

test("declared vacation evidence preserves its exact source and refuses malformed money or identity", () => {
  const requestId = "10000000-0000-4000-8000-000000000001";
  const note = declaredVacationAccrualEvidence(
    "Reviewed issued liability",
    "Issued cheque 7",
    requestId,
  );
  const evidence = parseDeclaredVacationAccrualEvidence(note)!;
  assert.equal(evidence.reason, "Reviewed issued liability");
  const valid = {
    ...evidence,
    adjustmentId: requestId,
    componentId: "10000000-0000-4000-8000-000000000002",
    amount: "2500.8100",
  };
  assert.equal(isDeclaredVacationAccrualInput(valid), true);
  for (const amount of ["0", "-1", "2500.8101", "2,500.81", "1e3"])
    assert.equal(isDeclaredVacationAccrualInput({ ...valid, amount }), false);
  assert.equal(isDeclaredVacationAccrualInput({ ...valid, requestId: "missing" }), false);
  assert.equal(parseDeclaredVacationAccrualEvidence('{"kind":"declared_vacation_accrual"}'), null);
});
