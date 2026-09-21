/**
 * AU STP finalisation figures: pure unit tests (no database, no install).
 *
 * The row-id grammar, the STP gross derivation, the financial-year label
 * and the year-coverage refusal live in the leaf ./stp-figures.ts precisely
 * so they run without a database — this file asserts them. The declaration
 * wiring (population, slip, amendment, download refusal) is asserted in
 * ./stp-finalisation.integration.test.ts, which owns a database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAuFinalisationYear,
  auFinancialYearLabel,
  parseStpFinalisationRowId,
  stpReportableGross,
} from "./stp-figures.ts";
import { PayrollPackError } from "../payroll-error.ts";

test("STP row ids round-trip every emitted shape and refuse foreign ones", () => {
  const employee = "123e4567-e89b-12d3-a456-426614174000";
  assert.deepEqual(parseStpFinalisationRowId(employee), { employees: [employee], accounts: [] });
  assert.equal(parseStpFinalisationRowId("not-a-uuid"), null);
  assert.equal(parseStpFinalisationRowId(""), null);
  // A W-2/T4-style compound key is not one of this filing's rows.
  assert.equal(parseStpFinalisationRowId(`${employee}:${employee}`), null);
  assert.equal(parseStpFinalisationRowId(`NSW:${employee}`), null);
});

test("STP-reportable gross lessens the total by each separately-itemised amount", () => {
  assert.equal(
    stpReportableGross({ gross: "5250.0000", overtime: "450.0000", bonusesCommissions: "0", paidLeave: "0" }),
    "4800.0000",
  );
  assert.equal(
    stpReportableGross({ gross: "5300.0000", overtime: "0", bonusesCommissions: "500.0000", paidLeave: "200.0000" }),
    "4600.0000",
  );
  assert.equal(
    stpReportableGross({ gross: "2400.0000", overtime: "0", bonusesCommissions: "0", paidLeave: "0" }),
    "2400.0000",
  );
});

test("financial-year labels resolve through the pack's own edition declaration", () => {
  assert.equal(auFinancialYearLabel(2027), "2026–27");
  assert.equal(auFinancialYearLabel(2026), "2025–26");
});

test("finalisation years refuse by name: draft, missing, and the published pass", () => {
  assert.doesNotThrow(() => assertAuFinalisationYear(2027));
  // 2026 is a scaffolded draft — the refusal names the year, never the database.
  assert.throws(
    () => assertAuFinalisationYear(2026),
    (error: unknown) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match((error as Error).message, /2026/);
      assert.match((error as Error).message, /draft|placeholder/i);
      return true;
    },
  );
  // 2025 was never transcribed — missing, not draft, still named.
  assert.throws(
    () => assertAuFinalisationYear(2025),
    (error: unknown) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match((error as Error).message, /2025/);
      return true;
    },
  );
});
