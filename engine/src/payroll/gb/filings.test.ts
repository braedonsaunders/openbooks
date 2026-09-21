/**
 * GB statement row-grammar and declaration tests — pure, no database.
 *
 * What these prove: the P60/P45 row ids round-trip through the pack's own
 * parseRowId (the subsidiary-scope guard authorizes bytes through this
 * grammar, so a grammar that lives only in the population builder cannot be
 * guarded), foreign grammars return null, and the declaration carries the
 * contract fields (cadence, slip, named RTI/P11D refusals, same-form
 * amendment). Run with
 * `node --import tsx engine/src/payroll/gb/filings.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gbPackFilings, gbTaxYearLabel, parseGbStatementRowId } from "./filings.ts";
import { gbTaxYearBounds } from "../yearend.ts";

const EMPLOYEE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";

test("statement row ids round-trip through the declared grammar", () => {
  assert.deepEqual(parseGbStatementRowId(`${EMPLOYEE}:${ACCOUNT}`), {
    employees: [EMPLOYEE],
    accounts: [ACCOUNT],
  });
  // The unassigned aggregate carries an empty account leg, like the W-2's.
  assert.deepEqual(parseGbStatementRowId(`${EMPLOYEE}:`), {
    employees: [EMPLOYEE],
    accounts: [],
  });
});

test("foreign row grammars return null, never a mis-scoped authorization", () => {
  // A CA T4 row (employee:province:account) must not authorize as a GB row.
  assert.equal(parseGbStatementRowId(`${EMPLOYEE}:ON:${ACCOUNT}`), null);
  // A bare employee id (the ROE grammar) is not a GB statement row either:
  // authorizing it here would scope a separation filing as an annual slip.
  assert.equal(parseGbStatementRowId(EMPLOYEE), null);
  assert.equal(parseGbStatementRowId("not-a-row"), null);
  assert.equal(parseGbStatementRowId(""), null);
});

test("the GB tax year bounds come from the pack definition, not the calendar", () => {
  assert.deepEqual(gbTaxYearBounds(2026), { start: "2026-04-06", end: "2027-04-05" });
  assert.equal(gbTaxYearLabel(2026), "2026/27");
});

test("the P60 is annual and refuses the submission standards by name", () => {
  const filing = gbPackFilings().yearEnd.find((declared) => declared.key === "p60")!;
  assert.equal(filing.label, "P60 End of Year Certificate");
  assert.equal(filing.cadence, "annual");
  assert.ok(filing.slip, "the employee statement renders");
  assert.ok(filing.downloadRefusal?.includes("Full Payment Submission"));
  assert.ok(filing.downloadRefusal?.includes("Employer Payment Summary"));
  assert.ok(filing.downloadRefusal?.includes("P11D"));
  assert.equal(filing.amendment.supported, true);
  if (filing.amendment.supported) {
    assert.deepEqual(filing.amendment.revisions, ["amended"]);
    assert.equal(filing.amendment.vehicle, "same_form");
    assert.ok(filing.amendment.downloadRefusal?.includes("FPS"));
  }
});

test("the P45 is separation-cadence and answers the leaver question", () => {
  const filing = gbPackFilings().yearEnd.find((declared) => declared.key === "p45")!;
  assert.equal(filing.cadence, "separation");
  assert.ok(filing.slip, "Parts 1A/2/3 render");
  // Part 1 rides the RTI leaver FPS: named, never implied.
  assert.ok(filing.downloadRefusal?.includes("Part 1"));
  assert.ok(filing.downloadRefusal?.includes("Full Payment Submission"));
  assert.equal(filing.amendment.supported, true);
});
