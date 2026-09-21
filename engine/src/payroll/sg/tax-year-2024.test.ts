/**
 * SG 2024 conformance goldens — pure, no database.
 *
 * Every golden below is a figure read out of the authority's own publication,
 * hand-worked independently of the engine and never pasted from engine output.
 * The primary source is the CPF Board's 2024 "Examples for computation of
 * Additional Wage (AW) Ceiling" (all three worked examples use a below-55
 * employee, so their OW rows are Board-printed Table 1 goldens):
 *
 * - Example 1 (monthly salary $7,000): "OW Paid $7,000, OW Subject to CPF
 *   $6,800, CPF Payable on OW: Employer $1,156, Employee $1,360" and
 *   "Additional Wage (AW) ceiling: $102,000 – ($6,800 x 12) = $20,400".
 * - Example 2 (monthly salary $4,500): "OW Paid $4,500, OW Subject to CPF
 *   $4,500, CPF Payable on OW: Employer $765, Employee $900" and
 *   "Additional Wage (AW) ceiling: $102,000 – ($4,500 x 12) = $48,000".
 * - Example 3 ($4,500 Jan–Mar, $6,000 Apr–Dec): $6,000 OW months print
 *   "Employer $1,020, Employee $1,200" (17% × 6,000 = 1,020;
 *   20% × 6,000 = 1,200 — the table's own arithmetic, shown, not engine
 *   output).
 *
 * The OW-ceiling and maxima constants come from Table 1 of
 * CPF_contribution_rates_from_1_Jan_2024.pdf (CPF Board): the 55-and-below
 * row ("[37% (OW)]* + 37% (AW)" / "[20% (OW)]* + 20% (AW)",
 * "* Max. of $2,516 / * Max. of $1,360") with the OW-ceiling note
 * ("capped at OW Ceiling of $6,800"). SDL goldens come from the Board's SDL
 * example table (standing figures, frozen since 2008).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../error.ts";
import {
  calculateSgStatutory,
  sgRatesForTaxYear,
} from "./cpf.ts";

const CITIZEN_LE55_2024 = { taxYear: 2024, cpfStatus: "citizen", ageBand: "le55" } as const;

test("2024 is transcribed; years outside 2024–2026 are refused by name", () => {
  assert.equal(sgRatesForTaxYear(2024), 2024);
  for (const year of [2023, 2027]) {
    assert.throws(() => sgRatesForTaxYear(year), PayrollError, `${year} refused`);
  }
});

test("Board AW-ceiling examples, ex. 1: $7,000 OW prices on the $6,800 ceiling", () => {
  // Printed OW row: "OW Paid $7,000, OW Subject to CPF $6,800, CPF Payable
  // on OW: Employer $1,156, Employee $1,360". Corroborated by the Table 1
  // arithmetic: 37% × 6,800 = 2,516 total; 20% × 6,800 = 1,360 employee;
  // 2,516 − 1,360 = 1,156 employer.
  const result = calculateSgStatutory({ ...CITIZEN_LE55_2024, ordinaryWages: "7000.00" });
  assert.equal(result.owSubjectCents, 680000n);
  assert.equal(result.totalCents, 251600n);
  assert.equal(result.employeeCents, 136000n);
  assert.equal(result.employerCents, 115600n);
});

test("Board AW-ceiling examples, ex. 2: $4,500 OW prices whole", () => {
  // Printed OW row: "OW Paid $4,500, OW Subject to CPF $4,500, CPF Payable
  // on OW: Employer $765, Employee $900".
  const result = calculateSgStatutory({ ...CITIZEN_LE55_2024, ordinaryWages: "4500.00" });
  assert.equal(result.owSubjectCents, 450000n);
  assert.equal(result.totalCents, 166500n);
  assert.equal(result.employeeCents, 90000n);
  assert.equal(result.employerCents, 76500n);
});

test("Board AW-ceiling examples, ex. 3: $6,000 OW prices whole", () => {
  // Printed OW row for the April–December months: "Employer $1,020,
  // Employee $1,200" — 17% × 6,000 and 20% × 6,000 by the table's own
  // arithmetic.
  const result = calculateSgStatutory({ ...CITIZEN_LE55_2024, ordinaryWages: "6000.00" });
  assert.equal(result.owSubjectCents, 600000n);
  assert.equal(result.totalCents, 222000n);
  assert.equal(result.employeeCents, 120000n);
  assert.equal(result.employerCents, 102000n);
});

test("SDL goldens from the Board's SDL example table (frozen figures)", () => {
  // B $2,000 → $5; C $4,500 → $11.25; A $609.50 → $2 minimum; D $4,502.03
  // → $11.25 maximum.
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55_2024, ordinaryWages: "2000.00" }).sdlCents,
    500n,
  );
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55_2024, ordinaryWages: "4500.00" }).sdlCents,
    1125n,
  );
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55_2024, ordinaryWages: "609.50" }).sdlCents,
    200n,
  );
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55_2024, ordinaryWages: "4502.03" }).sdlCents,
    1125n,
  );
});

test("the 2024 AW refusal names the 2024 ceiling, not a carried figure", () => {
  // "$102,000 – ($6,800 x 12) = $20,400" (Board AW-ceiling examples, 2024
  // edition, example 1).
  assert.throws(
    () => calculateSgStatutory({ ...CITIZEN_LE55_2024, ordinaryWages: "6800.00", additionalWages: "500.00" }),
    (error: Error) => {
      assert.ok(error instanceof PayrollError);
      assert.match(error.message, /refuses Additional Wages/);
      assert.match(error.message, /2024 AW ceiling/);
      assert.match(error.message, /\$20,400/);
      assert.match(error.message, /\$102,000/);
      return true;
    },
  );
});
