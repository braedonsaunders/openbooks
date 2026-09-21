/**
 * IE year-end filing: the PAYE Modernisation reconciliation.
 *
 * Ireland has no employer-issued annual slip to build — the P60 was abolished
 * with PAYE Modernisation (1 January 2019) and the Employment Detail Summary
 * is produced by Revenue from the employer's per-pay-period submissions, not
 * issued by the employer. So this filing declares no slip: its population is
 * the reconciliation an Irish employer CAN be given (PAYE, PRSI and USC per
 * employee, tying to the year's committed runs to the cent), its
 * downloadRefusal names the ROS submission channel, and its amendment names
 * the corrected-submission remedy.
 *
 * DB-free assertions only (declaration shape, row grammar, year coverage).
 * The population itself is DB-owned — see filings.integration.test.ts, whose
 * assertions are written to the standard, not executed on this machine.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IE_PAYE_RECONCILIATION_FILING,
  parseIeReconciliationRowId,
} from "./filings.ts";
import { payrollTaxYearProblem } from "../packs.ts";

const EMP = "12345678-1234-1234-1234-1234567890ab";
const ACCT = "abcdefab-abcd-abcd-abcd-abcdefabcdef";

describe("IE PAYE Modernisation reconciliation filing", () => {
  it("declares the annual reconciliation, not an employer slip", () => {
    assert.equal(IE_PAYE_RECONCILIATION_FILING.key, "paye-reconciliation");
    assert.equal(IE_PAYE_RECONCILIATION_FILING.cadence, "annual");
    assert.equal(IE_PAYE_RECONCILIATION_FILING.slip, undefined);
    assert.equal(typeof IE_PAYE_RECONCILIATION_FILING.population, "function");
    assert.equal(IE_PAYE_RECONCILIATION_FILING.parseRowId, parseIeReconciliationRowId);
  });

  it("names the ROS submission channel instead of a file", () => {
    assert.match(
      IE_PAYE_RECONCILIATION_FILING.downloadRefusal ?? "",
      /Revenue Online Service \(ROS\)/,
    );
  });

  it("refuses amendment in-product and names the corrected-submission remedy", () => {
    const amendment = IE_PAYE_RECONCILIATION_FILING.amendment;
    assert.equal(amendment.supported, false);
    assert.ok(amendment.refusal.trim().length > 0, "a refusal must say why, by name");
    assert.match(amendment.refusal, /corrected.*submission|resubmit/i);
  });

  it("round-trips every row id its population emits", () => {
    const scoped = parseIeReconciliationRowId(`${EMP}:${ACCT}`);
    assert.deepEqual(scoped, { employees: [EMP], accounts: [ACCT] });
    const unassigned = parseIeReconciliationRowId(`${EMP}:`);
    assert.deepEqual(unassigned, { employees: [EMP], accounts: [] });
  });

  it("returns null for anything that is not one of its rows", () => {
    assert.equal(parseIeReconciliationRowId("not-a-row"), null);
    assert.equal(parseIeReconciliationRowId(""), null);
    assert.equal(parseIeReconciliationRowId(`${EMP}:${ACCT}:extra`), null);
    assert.equal(parseIeReconciliationRowId(`not-a-uuid:${ACCT}`), null);
    assert.equal(parseIeReconciliationRowId(`${EMP}:not-a-uuid`), null);
    assert.equal(parseIeReconciliationRowId(`${EMP}`), null);
  });

  it("covers 2026 in this tree and refuses prior years by name", () => {
    assert.equal(payrollTaxYearProblem("IE", 2026), null);
    const problem = payrollTaxYearProblem("IE", 2025);
    assert.ok(problem, "2025 has no transcribed IE tables in this tree");
    assert.match(problem.message, /2025 statutory tables are not loaded for IE/);
  });
});
