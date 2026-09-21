/**
 * SG 2025 conformance goldens — pure, no database.
 *
 * Every golden below is a figure read out of the authority's own publication,
 * hand-worked independently of the engine and never pasted from engine output:
 *
 * - Table 1 of CPF_contribution_rates_from_1_Jan_2025.pdf (CPF Board): the
 *   55-and-below row ("> $500 to $750: 17% (TW) + 0.6 (TW - $500)" /
 *   "[37% (OW)]* + 37% (AW)" / "[20% (OW)]* + 20% (AW)", "* Max. of $2,738 /
 *   * Max. of $1,480") with the OW-ceiling note ("capped at OW ceiling of
 *   $7,400") and the computation steps (total half-up to the dollar,
 *   employee share floored, employer share the difference).
 * - The SDL example table on the CPF Board's Skills Development Levy page
 *   (A $609.50 → $2 minimum; B $2,000 → $5; C $4,500 → $11.25;
 *   D $4,502.03 → $11.25 maximum) — standing figures, frozen since 2008.
 * - IRAS, Central Provident Fund (CPF) Relief for employees: the 2025
 *   AW-ceiling arithmetic ($102,000 − $88,800 = $13,200), named by the AW
 *   refusal (AW itself is refused: no channel carries YTD OW).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../error.ts";
import {
  calculateSgStatutory,
  sgRatesForTaxYear,
} from "./cpf.ts";

const CITIZEN_LE55_2025 = { taxYear: 2025, cpfStatus: "citizen", ageBand: "le55" } as const;

test("2025 is transcribed; years outside 2024–2026 are refused by name", () => {
  assert.equal(sgRatesForTaxYear(2025), 2025);
  for (const year of [2023, 2027]) {
    assert.throws(() => sgRatesForTaxYear(year), PayrollError, `${year} refused`);
  }
});

test("Board Table 1: $9,000 OW prices on the $7,400 OW ceiling", () => {
  // Table 1, 55 & below, "> $750" row: "[37% (OW)]* / [20% (OW)]*",
  // "* Max. of $2,738 / * Max. of $1,480" on $7,400 of OW subject to CPF.
  // 37% × 7,400 = 2,738; 20% × 7,400 = 1,480; employer 2,738 − 1,480 = 1,258.
  const result = calculateSgStatutory({ ...CITIZEN_LE55_2025, ordinaryWages: "9000.00" });
  assert.equal(result.owSubjectCents, 740000n);
  assert.equal(result.totalCents, 273800n);
  assert.equal(result.employeeCents, 148000n);
  assert.equal(result.employerCents, 125800n);
});

test("Board Table 1: $4,500 OW prices whole", () => {
  // Below every ceiling, so no cap binds: 37% × 4,500 = 1,665 total,
  // 20% × 4,500 = 900 employee, 1,665 − 900 = 765 employer — hand-worked
  // from the Table 1 percentages (the same $765/$900 the Board prints for
  // $4,500 OW in its 2024 AW-ceiling examples, example 2).
  const result = calculateSgStatutory({ ...CITIZEN_LE55_2025, ordinaryWages: "4500.00" });
  assert.equal(result.owSubjectCents, 450000n);
  assert.equal(result.totalCents, 166500n);
  assert.equal(result.employeeCents, 90000n);
  assert.equal(result.employerCents, 76500n);
});

test("Board Table 1: the $500–$750 phase prices the 0.6 slope", () => {
  // "> $500 to $750: 17% (TW) + 0.6 (TW - $500)" total,
  // "0.6 (TW - $500)" employee. $600 → 102 + 60 = $162 total; $60
  // employee; $102 employer.
  const result = calculateSgStatutory({ ...CITIZEN_LE55_2025, ordinaryWages: "600.00" });
  assert.equal(result.totalCents, 16200n);
  assert.equal(result.employeeCents, 6000n);
  assert.equal(result.employerCents, 10200n);
});

test("SDL goldens from the Board's SDL example table (frozen figures)", () => {
  // B $2,000 → $5; C $4,500 → $11.25; A $609.50 → $2 minimum; D $4,502.03
  // → $11.25 maximum.
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55_2025, ordinaryWages: "2000.00" }).sdlCents,
    500n,
  );
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55_2025, ordinaryWages: "4500.00" }).sdlCents,
    1125n,
  );
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55_2025, ordinaryWages: "609.50" }).sdlCents,
    200n,
  );
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55_2025, ordinaryWages: "4502.03" }).sdlCents,
    1125n,
  );
});

test("the 2025 AW refusal names the 2025 ceiling, not a carried figure", () => {
  // $102,000 − ($7,400 × 12) = $13,200 (IRAS CPF-relief page, 2025 inputs).
  assert.throws(
    () => calculateSgStatutory({ ...CITIZEN_LE55_2025, ordinaryWages: "7400.00", additionalWages: "500.00" }),
    (error: Error) => {
      assert.ok(error instanceof PayrollError);
      assert.match(error.message, /refuses Additional Wages/);
      assert.match(error.message, /2025 AW ceiling/);
      assert.match(error.message, /\$13,200/);
      assert.match(error.message, /\$102,000/);
      return true;
    },
  );
});

test("a 3rd-year SPR prices the same 2025 Table 1 row as a citizen", () => {
  // Table 1 header: "for Singapore Citizens or Singapore Permanent
  // Residents (3rd year onwards)" — one row, two statuses.
  const citizen = calculateSgStatutory({ ...CITIZEN_LE55_2025, ordinaryWages: "7400.00" });
  const spr = calculateSgStatutory({ taxYear: 2025, cpfStatus: "spr_3rd_year", ageBand: "le55", ordinaryWages: "7400.00" });
  assert.deepEqual(spr, citizen);
});
