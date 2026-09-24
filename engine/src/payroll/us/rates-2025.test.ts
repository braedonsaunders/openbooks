/**
 * Pub 15-T 2025 conformance goldens.
 *
 * External goldens: the printed 2025 Annual Percentage Method schedules
 * (IRS Publication 15-T (2025), "For use in 2025", Cat. No. 32112B,
 * irs.gov/pub/irs-prior/p15t--2025.pdf, §1 p. 11) — every row's tentative
 * amount is re-derived from the cumulative bracket sums, so any
 * transcription drift in rates-2025.ts fails loudly — plus the SSA 2025
 * wage base (Federal Register 2024-24871) and the FUTA statutory constants.
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
import { RATES_2025 } from "./rates-2025.ts";

function calculateWithConfiguredFuta(input: Parameters<typeof calculatePub15T>[0]) {
  // Other conformance goldens set the ordinary full-credit FUTA rate explicitly.
  return calculatePub15T({ futaEffectiveRate: "0.006", ...input });
}

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

/**
 * Published goldens: periodic wages at P = 1, filing status, and the annual
 * withholding the 2025 STANDARD schedule produces at wages minus the line-1g
 * adjustment, taken from the publication's tables — including one in the top
 * bracket.
 */
const PUBLISHED: { annualWages: string; filingStatus: "single" | "married_joint" | "head_household"; annualTax: string }[] = [
  // AAWA 60,000 single: 5,578.50 + 22% × (60,000 − 54,875).
  { annualWages: "68600", filingStatus: "single", annualTax: money("6706") },
  // AAWA 150,000 MFJ: 11,157 + 22% × (150,000 − 114,050).
  { annualWages: "162900", filingStatus: "married_joint", annualTax: money("19066") },
  // AAWA 700,000 HoH (top bracket): 187,031.50 + 37% × (700,000 − 640,250).
  { annualWages: "708600", filingStatus: "head_household", annualTax: money("209139") },
];

test("2025 Pub 15-T tables are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(RATES_2025);
  assert.deepEqual(
    unfilled, [],
    "transcribe every 2025 figure from Pub 15-T — still unfilled: " + unfilled.join(", "),
  );
  assert.equal(
    RATES_2025.status, "published",
    "flip RATES_2025.status to published once every figure is transcribed",
  );
  // Published means calculable: the edition resolver must stop refusing it.
  assert.equal(ratesForPayDate("2025-01-15").year, 2025);
});

test("2025 published Pub 15-T goldens", () => {
  assert.ok(
    PUBLISHED.length >= 3,
    "paste at least three published 2025 goldens from Pub 15-T before paying into 2025",
  );
  for (const golden of PUBLISHED) {
    // Annual pay period (P = 1) so the schedule is exercised directly, with no
    // annualization or rounding of a periodic amount in the way.
    const result = calculateWithConfiguredFuta({
      payDate: "2025-06-15",
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

test("2025 printed schedules are internally consistent (cumulative bracket sums)", () => {
  // tentative[i+1] must equal tentative[i] + rate[i] × (atLeast[i+1] − atLeast[i]).
  // The single-filer checkbox schedule prints three thresholds rounded up from
  // half-dollar boundaries (13,462.50 → 13,463; 31,737.50 → 31,738;
  // 132,762.50 → 132,763) and rounds the top tentative up from 94,384.875, so
  // its recomputation may differ by rate × $0.50 — everywhere else is exact.
  for (const [kind, tables] of [["standard", RATES_2025.standard], ["checkbox", RATES_2025.checkbox]] as const) {
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

test("2025 standard schedules match the Rev. Proc. 2024-40 brackets shifted by the W-4 adjustment", () => {
  // STANDARD table start = standard deduction − Worksheet 1A adjustment.
  // 2025: single 15,000 − 8,600 = 6,400; MFJ 30,000 − 12,900 = 17,100;
  // HoH 22,500 − 8,600 = 13,900.
  assert.equal(RATES_2025.standard.single[1]!.atLeast, "6400");
  assert.equal(RATES_2025.standard.married_joint[1]!.atLeast, "17100");
  assert.equal(RATES_2025.standard.head_household[1]!.atLeast, "13900");
  // Checkbox table start = standard deduction ÷ 2.
  assert.equal(RATES_2025.checkbox.single[1]!.atLeast, "7500");
  assert.equal(RATES_2025.checkbox.married_joint[1]!.atLeast, "15000");
  assert.equal(RATES_2025.checkbox.head_household[1]!.atLeast, "11250");
});

test("2025 FICA/FUTA statutory constants (FR 2024-24871, IRC §3301)", () => {
  assert.equal(RATES_2025.fica.ssWageBase, "176100");
  assert.equal(RATES_2025.fica.ssRate, "0.062");
  assert.equal(RATES_2025.fica.medicareRate, "0.0145");
  assert.equal(RATES_2025.futa.wageBase, "7000");
  assert.equal(RATES_2025.futa.fullCreditEffectiveRate, "0.006");
});

test("2025 single, biweekly $2,000, default W-4 — full hand-worked stub", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2025-02-14", periodsPerYear: 26, wages: "2000.00", filingStatus: "single",
  });
  // 1b = 52,000; 1i = 52,000 − 8,600 = 43,400
  assert.equal(result.factors.AAWA, money("43400"));
  // 2g = 1,192.50 + 12% × (43,400 − 18,325) = 4,201.50; 2h = 4,201.50 ÷ 26 = 161.60
  assert.equal(result.factors.TW, money("4201.50"));
  assert.equal(result.fit, money("161.60"));
  assert.equal(result.ss, money("124.00")); // 2,000 × 6.2%
  assert.equal(result.medicare, money("29.00")); // 2,000 × 1.45%
  assert.equal(result.additionalMedicare, money("0"));
  assert.equal(result.futa, money("12.00")); // 2,000 × 0.6%
  assert.equal(result.suta, money("0"));
});

test("2025 pre-tax deferral consistency: FIT prices the reduced base", () => {
  // The deferral path (computeUsStatutory prices FIT on reducedBases.income)
  // feeds the post-deferral wage into these same 2025 tables: $2,000 less a
  // $200 401(k) deferral withholds as $1,800 of FIT-able wages while Social
  // Security and Medicare do not move.
  const full = calculateWithConfiguredFuta({
    payDate: "2025-02-14", periodsPerYear: 26, wages: "2000.00", filingStatus: "single",
  });
  const reduced = calculateWithConfiguredFuta({
    payDate: "2025-02-14", periodsPerYear: 26, wages: "1800.00", filingStatus: "single",
  });
  // 1i = 46,800 − 8,600 = 38,200
  assert.equal(reduced.factors.AAWA, money("38200"));
  // 2g = 1,192.50 + 12% × (38,200 − 18,325) = 3,577.50; ÷ 26 = 137.60
  assert.equal(reduced.fit, money("137.60"));
  assert.ok(Number(reduced.fit) < Number(full.fit));
  assert.equal(reduced.ss, money("111.60"));
  assert.equal(full.ss, money("124.00"));
});

test("2025 married filing jointly, semi-monthly $4,000, Step 3 credits $4,400", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2025-03-15", periodsPerYear: 24, wages: "4000.00",
    filingStatus: "married_joint", dependentCredits: "4400.00",
  });
  // 1i = 96,000 − 12,900 = 83,100; 2g = 2,385 + 12% × 42,150 = 7,443
  // 2h = 7,443 ÷ 24 = 310.13; 3b = 4,400 ÷ 24 = 183.33; 3c = 126.80
  assert.equal(result.factors.AAWA, money("83100"));
  assert.equal(result.fit, money("126.80"));
});

test("2025 single with the Step 2 checkbox, weekly $1,500 — checkbox schedule", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2025-01-10", periodsPerYear: 52, wages: "1500.00",
    filingStatus: "single", multipleJobs: true,
  });
  // 1i = 78,000 (no adjustment when the box is checked)
  // 2g = 8,825.50 + 24% × (78,000 − 59,175) = 13,343.50; ÷ 52 = 256.61
  assert.equal(result.factors.AAWA, money("78000"));
  assert.equal(result.fit, money("256.61"));
});

test("2025 Social Security wage-base crossing and Additional Medicare trigger", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2025-11-15", periodsPerYear: 24, wages: "3000.00", filingStatus: "single",
    ytd: { ssWages: "175000.00", medicareWages: "199000.00" },
  });
  // SS taxable = min(3,000, 176,100 − 175,000) = 1,100 → 68.20
  assert.equal(result.ss, money("68.20"));
  assert.equal(result.ssEmployer, money("68.20"));
  // Medicare is uncapped: 3,000 × 1.45% = 43.50
  assert.equal(result.medicare, money("43.50"));
  // Additional Medicare on the slice over 200,000: 2,000 × 0.9% = 18.00
  assert.equal(result.additionalMedicare, money("18.00"));
});
