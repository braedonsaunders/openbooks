/**
 * SG CPF/SDL engine tests — pure, no database.
 *
 * Proves the 2026 Table 1 transcription against the CPF Board's own worked
 * examples ("Examples for computation of Additional Wage (AW) Ceiling"):
 * a below-55 employee on $9,000 OW pays $1,360 employer / $1,600 employee
 * on $8,000 of OW subject to CPF, and on $4,500 OW pays $765 / $900. SDL
 * goldens come from the Board's SDL page example table (A $609.50 → $2
 * minimum; B $2,000 → $5; C $4,500 → $11.25; D $4,502.03 → $11.25 maximum).
 * Everything the engine has not transcribed is refused by name.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../error.ts";
import {
  assertSgCovered,
  calculateSgStatutory,
  sgRatesForTaxYear,
  sgTablesForTaxYear,
} from "./cpf.ts";

const CITIZEN_LE55 = { taxYear: 2026, cpfStatus: "citizen", ageBand: "le55" } as const;

test("2024–2026 are transcribed; every other year is refused by name", () => {
  assert.equal(sgRatesForTaxYear(2024), 2024);
  assert.equal(sgRatesForTaxYear(2025), 2025);
  assert.equal(sgRatesForTaxYear(2026), 2026);
  for (const year of [2023, 2027]) {
    assert.throws(() => sgRatesForTaxYear(year), PayrollError, `${year} refused`);
  }
});

test("Board example: $9,000 OW prices on the $8,000 OW ceiling", () => {
  // AW ceiling PDF §1 (below 55, Jan row): "OW Paid $9,000, OW Subject to
  // CPF $8,000, CPF Payable on OW: Employer $1,360, Employee $1,600".
  const result = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "9000.00" });
  assert.equal(result.owSubjectCents, 800000n);
  assert.equal(result.totalCents, 296000n);
  assert.equal(result.employeeCents, 160000n);
  assert.equal(result.employerCents, 136000n);
});

test("Board example: $4,500 OW prices whole", () => {
  // AW ceiling PDF §2 (below 55): "OW Paid $4,500, OW Subject to CPF
  // $4,500, CPF Payable on OW: Employer $765, Employee $900".
  const result = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "4500.00" });
  assert.equal(result.owSubjectCents, 450000n);
  assert.equal(result.totalCents, 166500n);
  assert.equal(result.employeeCents, 90000n);
  assert.equal(result.employerCents, 76500n);
});

test("the $2,960 / $1,600 OW maxima bind above the ceiling", () => {
  // $8,000 × 37% = $2,960 exactly; anything higher is capped, not priced.
  const result = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "20000.00" });
  assert.equal(result.owSubjectCents, 800000n);
  assert.equal(result.totalCents, 296000n);
  assert.equal(result.employeeCents, 160000n);
  assert.equal(result.employerCents, 136000n);
});

test("$50 or less of OW is Nil — no CPF either side", () => {
  const result = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "50.00" });
  assert.equal(result.totalCents, 0n);
  assert.equal(result.employeeCents, 0n);
  assert.equal(result.employerCents, 0n);
});

test("the $50–$500 phase prices 17% total with a Nil employee share", () => {
  // Table 1: "> $50 to $500: 17% (TW) / Nil". $400 → $68 total, $0 employee.
  const result = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "400.00" });
  assert.equal(result.totalCents, 6800n);
  assert.equal(result.employeeCents, 0n);
  assert.equal(result.employerCents, 6800n);
});

test("the $500–$750 phase prices the 0.6 slope on both sides", () => {
  // Table 1: "> $500 to $750: 17% (TW) + 0.6 (TW - $500)". $600 →
  // 102 + 60 = $162 total; $60 employee; $102 employer.
  const result = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "600.00" });
  assert.equal(result.totalCents, 16200n);
  assert.equal(result.employeeCents, 6000n);
  assert.equal(result.employerCents, 10200n);
});

test("a 3rd-year SPR prices the same Table 1 row as a citizen", () => {
  // Table 1 header: "for Singapore Citizens or Singapore Permanent
  // Residents (3rd year onwards)" — one row, two statuses.
  const citizen = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "4500.00" });
  const spr = calculateSgStatutory({ taxYear: 2026, cpfStatus: "spr_3rd_year", ageBand: "le55", ordinaryWages: "4500.00" });
  assert.deepEqual(spr, citizen);
});

test("SDL goldens from the Board's SDL example table", () => {
  // Employee B $2,000 → $5; C $4,500 → $11.25; A $609.50 → $2 minimum
  // ("Minimum of $2 is payable because the total wages are less than $800").
  const b = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "2000.00" });
  assert.equal(b.sdlCents, 500n);
  const c = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "4500.00" });
  assert.equal(c.sdlCents, 1125n);
  const a = calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "609.50" });
  assert.equal(a.sdlCents, 200n);
});

test("SDL caps above $4,500 and floors below $800", () => {
  // D $4,502.03 → $11.25 ("Maximum of $11.25 is payable because the total
  // wages are more than $4,500"); E $10,000 → $11.25.
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "4502.03" }).sdlCents,
    1125n,
  );
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "10000.00" }).sdlCents,
    1125n,
  );
  assert.equal(
    calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "100.00" }).sdlCents,
    200n,
  );
});

test("any Additional Wages are refused — the AW ceiling is year-dependent", () => {
  assert.throws(
    () => calculateSgStatutory({ ...CITIZEN_LE55, ordinaryWages: "4500.00", additionalWages: "500.00" }),
    (error: Error) => {
      assert.ok(error instanceof PayrollError);
      assert.match(error.message, /Additional Wages.*refuses|refuses Additional Wages/);
      assert.match(error.message, /\$102,000/);
      return true;
    },
  );
});

test("foreigners, graduated SPR years and other age bands are refused by name", () => {
  const tables2026 = sgTablesForTaxYear(2026);
  assert.throws(
    () => assertSgCovered("foreigner", "le55", tables2026),
    /no CPF for a foreign employee.*levy instead/,
  );
  assert.throws(
    () => assertSgCovered("spr_1st_year", "le55", tables2026),
    /graduated rates by name/,
  );
  assert.throws(
    () => assertSgCovered("spr_2nd_year", "le55", tables2026),
    /graduated rates by name/,
  );
  for (const band of ["b55_60", "b60_65", "b65_70", "gt70"] as const) {
    assert.throws(() => assertSgCovered("citizen", band, tables2026), /refuses the ".*" age band by name/, band);
  }
  assert.throws(() => assertSgCovered("citizen" as never, "xx" as never, tables2026), /age band/);
  assert.throws(
    () => calculateSgStatutory({ taxYear: 2026, cpfStatus: "foreigner", ageBand: "le55", ordinaryWages: "4500.00" }),
    /no CPF for a foreign employee/,
  );
});

test("the over-55 refusal names the calling year's own maxima (2024 vs 2026)", () => {
  // The 55-and-below OW-leg maxima move with the OW ceiling: 2024 prints
  // $2,516 / $1,360, 2025 $2,738 / $1,480, 2026 $2,960 / $1,600 (each year
  // module quotes its own Table 1). A refusal citing 2026 figures for a
  // 2024 run would misstate the year's own table.
  assert.throws(
    () => calculateSgStatutory({ taxYear: 2024, cpfStatus: "citizen", ageBand: "b55_60", ordinaryWages: "4500.00" }),
    (error: Error) => {
      assert.ok(error instanceof PayrollError);
      assert.match(error.message, /\$2,516\.00/);
      assert.match(error.message, /\$1,360\.00/);
      assert.doesNotMatch(error.message, /\$2,960/);
      return true;
    },
  );
  assert.throws(
    () => calculateSgStatutory({ taxYear: 2026, cpfStatus: "citizen", ageBand: "b60_65", ordinaryWages: "4500.00" }),
    (error: Error) => {
      assert.ok(error instanceof PayrollError);
      assert.match(error.message, /\$2,960\.00/);
      assert.match(error.message, /\$1,600\.00/);
      return true;
    },
  );
  // The guard reads the same tables object the calculation prices from.
  assert.throws(
    () => assertSgCovered("citizen", "b65_70", sgTablesForTaxYear(2025)),
    /\$2,738\.00/,
  );
});
