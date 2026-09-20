/**
 * Pub 15-T 2024 conformance goldens.
 *
 * External goldens: the printed 2024 Annual Percentage Method schedules
 * (IRS Publication 15-T (2024), "For use in 2024", Cat. No. 32112B,
 * irs.gov/pub/irs-prior/p15t--2024.pdf, §1 p. 11) — every row's tentative
 * amount is re-derived from the cumulative bracket sums, so any
 * transcription drift in rates-2024.ts fails loudly — plus the SSA 2024
 * wage base (Federal Register 2023-23317) and the FUTA statutory constants.
 * The full-stub cases are hand-worked through Worksheet 1A line by line
 * (round at each line), independent of the engine code.
 *
 * NOTE on the PUBLISHED goldens below: with an annual pay period (P = 1)
 * the engine still applies the Worksheet 1A line-1g adjustment, so each
 * golden's `annualWages` is the schedule amount PLUS the adjustment
 * (8,600 single/HoH, 12,900 MFJ) — the `annualTax` is the pure printed-
 * schedule value at the adjusted amount.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unfilledPaths } from "../unfilled.ts";
import { calculatePub15T } from "./pub15t.ts";
import { ratesForPayDate } from "./rates.ts";
import { RATES_2024 } from "./rates-2024.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

/**
 * Published goldens: periodic wages at P = 1, filing status, and the annual
 * withholding the 2024 STANDARD schedule produces at wages minus the line-1g
 * adjustment, taken from the publication's tables — including one in the top
 * bracket.
 */
const PUBLISHED: { annualWages: string; filingStatus: "single" | "married_joint" | "head_household"; annualTax: string }[] = [
  // AAWA 60,000 single: 5,426 + 22% × (60,000 − 53,150).
  { annualWages: "68600", filingStatus: "single", annualTax: money("6933") },
  // AAWA 150,000 MFJ: 10,852 + 22% × (150,000 − 110,600).
  { annualWages: "162900", filingStatus: "married_joint", annualTax: money("19520") },
  // AAWA 650,000 single (top bracket): 183,647.25 + 37% × (650,000 − 615,350).
  { annualWages: "658600", filingStatus: "single", annualTax: money("196467.75") },
];

test("2024 Pub 15-T tables are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(RATES_2024);
  assert.deepEqual(
    unfilled, [],
    "transcribe every 2024 figure from Pub 15-T — still unfilled: " + unfilled.join(", "),
  );
  assert.equal(
    RATES_2024.status, "published",
    "flip RATES_2024.status to published once every figure is transcribed",
  );
  // Published means calculable: the edition resolver must stop refusing it.
  assert.equal(ratesForPayDate("2024-01-15").year, 2024);
});

test("2024 published Pub 15-T goldens", () => {
  assert.ok(
    PUBLISHED.length >= 3,
    "paste at least three published 2024 goldens from Pub 15-T before paying into 2024",
  );
  for (const golden of PUBLISHED) {
    // Annual pay period (P = 1) so the schedule is exercised directly, with no
    // annualization or rounding of a periodic amount in the way.
    const result = calculatePub15T({
      payDate: "2024-06-15",
      periodsPerYear: 1,
      wages: golden.annualWages,
      filingStatus: golden.filingStatus,
    });
    assert.equal(
      result.fit, golden.annualTax,
      golden.filingStatus + " at " + golden.annualWages,
    );
  }
});

test("2024 printed schedules are internally consistent (cumulative bracket sums)", () => {
  // tentative[i+1] must equal tentative[i] + rate[i] × (atLeast[i+1] − atLeast[i]).
  // The single-filer checkbox schedule prints two thresholds rounded up from
  // half-dollar boundaries (57,562.50 → 57,563; 129,162.50 → 129,163) and
  // rounds the top tentative up from 91,823.625, so its recomputation may
  // differ by rate × $0.50 — everywhere else is exact.
  for (const [kind, tables] of [["standard", RATES_2024.standard], ["checkbox", RATES_2024.checkbox]] as const) {
    for (const [status, schedule] of Object.entries(tables)) {
      for (let i = 0; i + 1 < schedule.length; i++) {
        const expected = Number(schedule[i]!.tentative)
          + Number(schedule[i]!.rate) * (Number(schedule[i + 1]!.atLeast) - Number(schedule[i]!.atLeast));
        const printed = Number(schedule[i + 1]!.tentative);
        const tolerance = kind === "checkbox" && status === "single" ? 0.2 : 0.005;
        assert.ok(
          Math.abs(printed - expected) <= tolerance,
          `${kind}/${status} row ${i + 1}: printed ${printed}, cumulative ${expected}`,
        );
      }
    }
  }
});

test("2024 standard schedules match the Rev. Proc. 2023-34 brackets shifted by the W-4 adjustment", () => {
  // STANDARD table start = standard deduction − Worksheet 1A adjustment.
  // 2024: single 14,600 − 8,600 = 6,000; MFJ 29,200 − 12,900 = 16,300;
  // HoH 21,900 − 8,600 = 13,300.
  assert.equal(RATES_2024.standard.single[1]!.atLeast, "6000");
  assert.equal(RATES_2024.standard.married_joint[1]!.atLeast, "16300");
  assert.equal(RATES_2024.standard.head_household[1]!.atLeast, "13300");
  // Checkbox table start = standard deduction ÷ 2.
  assert.equal(RATES_2024.checkbox.single[1]!.atLeast, "7300");
  assert.equal(RATES_2024.checkbox.married_joint[1]!.atLeast, "14600");
  assert.equal(RATES_2024.checkbox.head_household[1]!.atLeast, "10950");
});

test("2024 FICA/FUTA statutory constants (FR 2023-23317, IRC §3301)", () => {
  assert.equal(RATES_2024.fica.ssWageBase, "168600");
  assert.equal(RATES_2024.fica.ssRate, "0.062");
  assert.equal(RATES_2024.fica.medicareRate, "0.0145");
  assert.equal(RATES_2024.futa.wageBase, "7000");
  assert.equal(RATES_2024.futa.defaultEffectiveRate, "0.006");
});

test("2024 single, biweekly $2,000, default W-4 — full hand-worked stub", () => {
  const result = calculatePub15T({
    payDate: "2024-02-16", periodsPerYear: 26, wages: "2000.00", filingStatus: "single",
  });
  // 1b = 52,000; 1i = 52,000 − 8,600 = 43,400
  assert.equal(result.factors.AAWA, money("43400"));
  // 2g = 1,160 + 12% × (43,400 − 17,600) = 4,256; 2h = 4,256 ÷ 26 = 163.69
  assert.equal(result.factors.TW, money("4256"));
  assert.equal(result.fit, money("163.69"));
  assert.equal(result.ss, money("124.00")); // 2,000 × 6.2%
  assert.equal(result.medicare, money("29.00")); // 2,000 × 1.45%
  assert.equal(result.additionalMedicare, money("0"));
  assert.equal(result.futa, money("12.00")); // 2,000 × 0.6%
  assert.equal(result.suta, money("0"));
});

test("2024 pre-tax deferral consistency: FIT prices the reduced base", () => {
  // The deferral path (computeUsStatutory prices FIT on reducedBases.income)
  // feeds the post-deferral wage into these same 2024 tables: $2,000 less a
  // $200 401(k) deferral withholds as $1,800 of FIT-able wages while Social
  // Security and Medicare do not move.
  const full = calculatePub15T({
    payDate: "2024-02-16", periodsPerYear: 26, wages: "2000.00", filingStatus: "single",
  });
  const reduced = calculatePub15T({
    payDate: "2024-02-16", periodsPerYear: 26, wages: "1800.00", filingStatus: "single",
  });
  // 1i = 46,800 − 8,600 = 38,200
  assert.equal(reduced.factors.AAWA, money("38200"));
  // 2g = 1,160 + 12% × (38,200 − 17,600) = 3,632; ÷ 26 = 139.69
  assert.equal(reduced.fit, money("139.69"));
  assert.ok(Number(reduced.fit) < Number(full.fit));
  assert.equal(reduced.ss, money("111.60"));
  assert.equal(full.ss, money("124.00"));
});

test("2024 married filing jointly, semi-monthly $4,000, Step 3 credits $4,400", () => {
  const result = calculatePub15T({
    payDate: "2024-03-15", periodsPerYear: 24, wages: "4000.00",
    filingStatus: "married_joint", dependentCredits: "4400.00",
  });
  // 1i = 96,000 − 12,900 = 83,100; 2g = 2,320 + 12% × 43,600 = 7,552
  // 2h = 7,552 ÷ 24 = 314.67; 3b = 4,400 ÷ 24 = 183.33; 3c = 131.34
  assert.equal(result.factors.AAWA, money("83100"));
  assert.equal(result.fit, money("131.34"));
});

test("2024 single with the Step 2 checkbox, weekly $1,500 — checkbox schedule", () => {
  const result = calculatePub15T({
    payDate: "2024-01-12", periodsPerYear: 52, wages: "1500.00",
    filingStatus: "single", multipleJobs: true,
  });
  // 1i = 78,000 (no adjustment when the box is checked)
  // 2g = 8,584.25 + 24% × (78,000 − 57,563) = 13,489.13; ÷ 52 = 259.41
  assert.equal(result.factors.AAWA, money("78000"));
  assert.equal(result.fit, money("259.41"));
});

test("2024 Social Security wage-base crossing and Additional Medicare trigger", () => {
  const result = calculatePub15T({
    payDate: "2024-11-15", periodsPerYear: 24, wages: "3000.00", filingStatus: "single",
    ytd: { ssWages: "167000.00", medicareWages: "199000.00" },
  });
  // SS taxable = min(3,000, 168,600 − 167,000) = 1,600 → 99.20
  assert.equal(result.ss, money("99.20"));
  assert.equal(result.ssEmployer, money("99.20"));
  // Medicare is uncapped: 3,000 × 1.45% = 43.50
  assert.equal(result.medicare, money("43.50"));
  // Additional Medicare on the slice over 200,000: 2,000 × 0.9% = 18.00
  assert.equal(result.additionalMedicare, money("18.00"));
});
