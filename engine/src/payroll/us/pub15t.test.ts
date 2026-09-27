/**
 * Pub 15-T conformance goldens, 2024–2026.
 *
 * External goldens: the printed Annual Percentage Method schedules of each
 * edition (IRS Publication 15-T, irs.gov/publications/p15t; prior years at
 * irs.gov/pub/irs-prior/p15t--YYYY.pdf, §1 p. 11) — every row's tentative
 * amount is re-derived from the cumulative bracket sums, so transcription
 * drift in rates.ts / rates-YYYY.ts fails loudly — plus the SSA wage bases
 * and FUTA statutory figures. Full-stub rows are hand-worked through
 * Worksheet 1A line by line (round at each line), independent of the engine.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { payrollCertificate, resolveCertificate } from "../certificates.ts";
import { PAYROLL_COUNTRY_PACKS } from "../packs.ts";
import { unfilledPaths } from "../unfilled.ts";
import { requireUsFederalAlienStatus } from "./employee-facts.ts";
import { calculatePub15T, futaScheduleATrueUp, type Pub15TInput, type Pub15TResult } from "./pub15t.ts";
import { NO_WITHHOLDING_STATES, RATES_2026, ratesForPayDate, US_STATES } from "./rates.ts";
import { RATES_2024 } from "./rates-2024.ts";
import { RATES_2025 } from "./rates-2025.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

type ResultKey = Exclude<keyof Pub15TResult, "factors" | "year">;

interface Golden {
  year: 2024 | 2025 | 2026;
  label: string;
  citation: string;
  /** Rows run with the ordinary full-credit FUTA rate (0.6 %) unless they set their own. */
  input: Omit<Pub15TInput, "payDate"> & { payDate: string };
  expected: Partial<Record<ResultKey, string>>;
  expectedFactors?: Record<string, string>;
}

const P15T_2024 = "IRS Pub 15-T (2024), Cat. No. 32112B, Worksheet 1A";
const P15T_2025 = "IRS Pub 15-T (2025), Cat. No. 32112B, Worksheet 1A";
const P15T_2026 = "IRS Pub 15-T (2026), Worksheet 1A";
const PUB15_S7 = "IRS Pub 15 §7 supplemental wages (irs.gov/publications/p15)";
const biweekly2000 = (payDate: string) =>
  ({ payDate, periodsPerYear: 26, wages: "2000.00", filingStatus: "single" }) as const;

// PUBLISHED rows run at an annual pay period (P = 1) so the printed STANDARD
// schedule is exercised directly. The engine still applies the Worksheet 1A
// line-1g adjustment at P = 1, so `wages` is the schedule amount PLUS 8,600
// (single/HoH) or 12,900 (MFJ); `fit` is the printed-schedule value.
const GOLDENS: readonly Golden[] = [
  // ── 2026 ──
  { year: 2026, label: "single, biweekly $2,000, default W-4 — full hand-worked stub",
    citation: `${P15T_2026}; SSA 2026 wage base; IRC §3301`,
    // 1i = 52,000 − 8,600 = 43,400; 2g = 1,240 + 12% × (43,400 − 19,900) = 4,060; ÷ 26 = 156.15
    input: biweekly2000("2026-02-13"),
    expected: { fit: "156.15", ss: "124.00", medicare: "29.00", additionalMedicare: "0", futa: "12.00", suta: "0" },
    expectedFactors: { AAWA: "43400", TW: "4060" } },
  { year: 2026, label: "married filing jointly, semi-monthly $4,000, Step 3 credits $4,400",
    citation: P15T_2026,
    // 2g = 2,480 + 12% × 39,000 = 7,160; ÷ 24 = 298.33; − 4,400 ÷ 24 = 183.33 → 115.00
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "4000.00", filingStatus: "married_joint", dependentCredits: "4400.00" },
    expected: { fit: "115.00" }, expectedFactors: { AAWA: "83100" } },
  { year: 2026, label: "single with the Step 2 checkbox, weekly $1,500 — checkbox schedule",
    citation: P15T_2026,
    // No line-1g adjustment when the box is checked; 2g = 8,983 + 24% × (78,000 − 60,900) = 13,087; ÷ 52
    input: { payDate: "2026-01-09", periodsPerYear: 52, wages: "1500.00", filingStatus: "single", multipleJobs: true },
    expected: { fit: "251.67" }, expectedFactors: { AAWA: "78000" } },
  { year: 2026, label: "head of household, biweekly $3,000, 4(a) 10,000 / 4(b) 5,000 / 4(c) 50",
    citation: P15T_2026,
    // 1i = 78,000 + 10,000 − 5,000 − 8,600 = 74,400; 2g = 1,770 + 12% × 41,150 = 6,708; ÷ 26 + 50
    input: { payDate: "2026-05-08", periodsPerYear: 26, wages: "3000.00", filingStatus: "head_household",
      otherIncomeAnnual: "10000.00", deductionsAnnual: "5000.00", extraPerPeriod: "50.00" },
    expected: { fit: "308.00" }, expectedFactors: { AAWA: "74400" } },
  { year: 2026, label: "2019-or-earlier W-4: married, 3 allowances, monthly $5,000 (pre-2020 marital status wins)",
    citation: `${P15T_2026} lines 1k–1l`,
    // 1l = 60,000 − 3 × 4,300 = 47,100 on the STANDARD MFJ schedule; 2g = 2,480 + 12% × 3,000 = 2,840; ÷ 12
    input: { payDate: "2026-06-30", periodsPerYear: 12, wages: "5000.00", filingStatus: "single", pre2020: { allowances: 3, married: true } },
    expected: { fit: "236.67" }, expectedFactors: { AAWA: "47100" } },
  { year: 2026, label: "2019-or-earlier W-4 with zero allowances withholds from dollar one",
    citation: `${P15T_2026} lines 1k–1l`,
    // 1l = 60,000; 2g = 5,800 + 22% × 2,100 = 6,262; ÷ 12 = 521.83
    input: { payDate: "2026-06-30", periodsPerYear: 12, wages: "5000.00", filingStatus: "single", pre2020: { allowances: 0, married: false } },
    expected: { fit: "521.83" }, expectedFactors: { AAWA: "60000" } },
  { year: 2026, label: "Social Security wage-base crossing and Additional Medicare trigger",
    citation: "SSA 2026 wage base $184,500; IRC §3101(b)(2) $200,000 threshold",
    // SS on min(3,000, 184,500 − 183,000) = 1,500; Additional Medicare on 2,000 over 200,000 × 0.9%
    input: { payDate: "2026-11-15", periodsPerYear: 24, wages: "3000.00", filingStatus: "single",
      ytd: { ssWages: "183000.00", medicareWages: "199000.00" } },
    expected: { ss: "93.00", ssEmployer: "93.00", medicare: "43.50", additionalMedicare: "18.00" } },
  { year: 2026, label: "Additional Medicare when YTD wages already exceed $200,000 taxes only the new slice",
    citation: "IRC §3101(b)(2); Form 941 instructions line 5d",
    // max0(204,000 − 200,000) − max0(201,000 − 200,000) = 3,000 × 0.9% = 27.00, never 45.00.
    input: { payDate: "2026-11-15", periodsPerYear: 24, wages: "3000.00", filingStatus: "single", ytd: { medicareWages: "201000.00" } },
    expected: { medicare: "43.50", additionalMedicare: "27.00" }, expectedFactors: { MED2_TAXABLE: "3000.00" } },
  { year: 2026, label: "FUTA cap and configured SUI",
    citation: "IRC §3306(b)(1) $7,000 FUTA base; configured SUI 2.7% on $9,000",
    input: { payDate: "2026-04-15", periodsPerYear: 26, wages: "1000.00", filingStatus: "single",
      sui: { rate: "0.027", wageBase: "9000" }, ytd: { futaWages: "6500.00", suiWages: "8500.00" } },
    expected: { futa: "3.00", suta: "13.50" } },
  // The credit reduction is a Form 940 year-end true-up: per-period payroll
  // attributes nothing and refuses nothing, even across UI jurisdictions.
  { year: 2026, label: "FUTA per-period accrues the net rate across UI jurisdictions, never a Schedule A gate",
    citation: "IRS Instructions for Form 940 (irs.gov/instructions/i940)",
    input: { payDate: "2026-04-15", periodsPerYear: 26, wages: "1000.00", filingStatus: "single",
      futaEffectiveRate: "0.012", futaWorkAllocations: [{ region: "CA" }, { region: "TX" }] },
    expected: { futa: "12.00" } },
  { year: 2026, label: "supplemental $5,000 at the 22% flat rate beside periodic 156.15; FICA/FUTA bases include it",
    citation: PUB15_S7,
    input: { ...biweekly2000("2026-12-15"), supplemental: "5000.00" },
    expected: { fitSupplemental: "1100.00", fit: "1256.15", ss: "434.00", futa: "42.00" } },
  { year: 2026, label: "supplemental past $1,000,000 YTD: $2k at 22% + $8k at 37%",
    citation: PUB15_S7,
    input: { payDate: "2026-12-15", periodsPerYear: 26, wages: "0.00", supplemental: "10000.00", filingStatus: "single",
      ytd: { supplemental: "998000.00" } },
    expected: { fitSupplemental: "3400.00" } },
  // FUTA's federal exclusions do not decide state UI coverage; California
  // distinguishes FUTA-exempt public employers from tax-rated UI employers.
  { year: 2026, label: "FIT-exempt still withholds the mandatory 37% supplemental slice",
    citation: `${PUB15_S7}; edd.ca.gov/tax-rated-employers`,
    input: { ...biweekly2000("2026-02-13"), fitExempt: true, supplemental: "10000.00", ytd: { supplemental: "998000.00" }, extraPerPeriod: "25.00" },
    expected: { fit: "2960.00", ss: "744.00", medicare: "174.00" } },
  { year: 2026, label: "FICA-exempt prices FIT only",
    citation: `${P15T_2026}; IRS Pub 15`,
    input: { ...biweekly2000("2026-02-13"), ficaExempt: true },
    expected: { fit: "156.15", ss: "0", medicare: "0", additionalMedicare: "0" } },
  { year: 2026, label: "FUTA-exempt still prices SUI",
    citation: "IRS Pub 15; edd.ca.gov/tax-rated-employers",
    input: { ...biweekly2000("2026-02-13"), futaExempt: true, sui: { rate: "0.027", wageBase: "9000" } },
    expected: { futa: "0", suta: "54.00" } },
  { year: 2026, label: "SUI-exempt still prices FUTA",
    citation: "IRS Pub 15; edd.ca.gov/tax-rated-employers",
    input: { ...biweekly2000("2026-02-13"), suiExempt: true, sui: { rate: "0.027", wageBase: "9000" } },
    expected: { futa: "12.00", suta: "0" } },
  { year: 2026, label: "annual pay period (P = 1) exercises the schedule with no annualization",
    citation: P15T_2026,
    // 1i = 60,000 − 8,600 = 51,400; 2g = 1,240 + 12% × 31,500 = 5,020
    input: { payDate: "2026-06-15", periodsPerYear: 1, wages: "60000.00", filingStatus: "single" },
    expected: { fit: "5020.00" }, expectedFactors: { AAWA: "51400" } },
  { year: 2026, label: "P = 2000, the highest documented frequency: 5,020 ÷ 2,000",
    citation: P15T_2026,
    input: { payDate: "2026-06-15", periodsPerYear: 2000, wages: "30.00", filingStatus: "single" },
    expected: { fit: "2.51" } },

  // ── 2025 ──
  { year: 2025, label: "published: AAWA 60,000 single — 5,578.50 + 22% × (60,000 − 54,875)",
    citation: `${P15T_2025} STANDARD schedule`,
    input: { payDate: "2025-06-15", periodsPerYear: 1, wages: "68600", filingStatus: "single" }, expected: { fit: "6706" } },
  { year: 2025, label: "published: AAWA 150,000 MFJ — 11,157 + 22% × (150,000 − 114,050)",
    citation: `${P15T_2025} STANDARD schedule`,
    input: { payDate: "2025-06-15", periodsPerYear: 1, wages: "162900", filingStatus: "married_joint" }, expected: { fit: "19066" } },
  { year: 2025, label: "published: AAWA 700,000 HoH (top bracket) — 187,031.50 + 37% × (700,000 − 640,250)",
    citation: `${P15T_2025} STANDARD schedule`,
    input: { payDate: "2025-06-15", periodsPerYear: 1, wages: "708600", filingStatus: "head_household" }, expected: { fit: "209139" } },
  { year: 2025, label: "single, biweekly $2,000, default W-4 — full hand-worked stub",
    citation: `${P15T_2025}; SSA 2025 wage base (FR 2024-24871); IRC §3301`,
    // 2g = 1,192.50 + 12% × (43,400 − 18,325) = 4,201.50; ÷ 26 = 161.60
    input: biweekly2000("2025-02-14"),
    expected: { fit: "161.60", ss: "124.00", medicare: "29.00", additionalMedicare: "0", futa: "12.00", suta: "0" },
    expectedFactors: { AAWA: "43400", TW: "4201.50" } },
  { year: 2025, label: "pre-tax deferral: $2,000 less $200 401(k) prices FIT on $1,800; SS on the deferral-reduced wage",
    citation: P15T_2025,
    // 1i = 46,800 − 8,600 = 38,200; 2g = 1,192.50 + 12% × (38,200 − 18,325) = 3,577.50; ÷ 26
    input: { ...biweekly2000("2025-02-14"), wages: "1800.00" },
    expected: { fit: "137.60", ss: "111.60" }, expectedFactors: { AAWA: "38200" } },
  { year: 2025, label: "married filing jointly, semi-monthly $4,000, Step 3 credits $4,400",
    citation: P15T_2025,
    // 2g = 2,385 + 12% × 42,150 = 7,443; ÷ 24 = 310.13; − 183.33 → 126.80
    input: { payDate: "2025-03-15", periodsPerYear: 24, wages: "4000.00", filingStatus: "married_joint", dependentCredits: "4400.00" },
    expected: { fit: "126.80" }, expectedFactors: { AAWA: "83100" } },
  { year: 2025, label: "single with the Step 2 checkbox, weekly $1,500 — checkbox schedule",
    citation: P15T_2025,
    // 2g = 8,825.50 + 24% × (78,000 − 59,175) = 13,343.50; ÷ 52
    input: { payDate: "2025-01-10", periodsPerYear: 52, wages: "1500.00", filingStatus: "single", multipleJobs: true },
    expected: { fit: "256.61" }, expectedFactors: { AAWA: "78000" } },
  { year: 2025, label: "Social Security wage-base crossing and Additional Medicare trigger",
    citation: "SSA 2025 wage base $176,100 (FR 2024-24871); IRC §3101(b)(2)",
    input: { payDate: "2025-11-15", periodsPerYear: 24, wages: "3000.00", filingStatus: "single",
      ytd: { ssWages: "175000.00", medicareWages: "199000.00" } },
    expected: { ss: "68.20", ssEmployer: "68.20", medicare: "43.50", additionalMedicare: "18.00" } },

  // ── 2024 ──
  { year: 2024, label: "published: AAWA 60,000 single — 5,426 + 22% × (60,000 − 53,150)",
    citation: `${P15T_2024} STANDARD schedule`,
    input: { payDate: "2024-06-15", periodsPerYear: 1, wages: "68600", filingStatus: "single" }, expected: { fit: "6933" } },
  { year: 2024, label: "published: AAWA 150,000 MFJ — 10,852 + 22% × (150,000 − 110,600)",
    citation: `${P15T_2024} STANDARD schedule`,
    input: { payDate: "2024-06-15", periodsPerYear: 1, wages: "162900", filingStatus: "married_joint" }, expected: { fit: "19520" } },
  { year: 2024, label: "published: AAWA 650,000 single (top bracket) — 183,647.25 + 37% × (650,000 − 615,350)",
    citation: `${P15T_2024} STANDARD schedule`,
    input: { payDate: "2024-06-15", periodsPerYear: 1, wages: "658600", filingStatus: "single" }, expected: { fit: "196467.75" } },
  { year: 2024, label: "single, biweekly $2,000, default W-4 — full hand-worked stub",
    citation: `${P15T_2024}; SSA 2024 wage base (FR 2023-23317); IRC §3301`,
    // 2g = 1,160 + 12% × (43,400 − 17,600) = 4,256; ÷ 26 = 163.69
    input: biweekly2000("2024-02-16"),
    expected: { fit: "163.69", ss: "124.00", medicare: "29.00", additionalMedicare: "0", futa: "12.00", suta: "0" },
    expectedFactors: { AAWA: "43400", TW: "4256" } },
  { year: 2024, label: "pre-tax deferral: $2,000 less $200 401(k) prices FIT on $1,800; SS on the deferral-reduced wage",
    citation: P15T_2024,
    // 2g = 1,160 + 12% × (38,200 − 17,600) = 3,632; ÷ 26 = 139.69
    input: { ...biweekly2000("2024-02-16"), wages: "1800.00" },
    expected: { fit: "139.69", ss: "111.60" }, expectedFactors: { AAWA: "38200" } },
  { year: 2024, label: "married filing jointly, semi-monthly $4,000, Step 3 credits $4,400",
    citation: P15T_2024,
    // 2g = 2,320 + 12% × 43,600 = 7,552; ÷ 24 = 314.67; − 183.33 → 131.34
    input: { payDate: "2024-03-15", periodsPerYear: 24, wages: "4000.00", filingStatus: "married_joint", dependentCredits: "4400.00" },
    expected: { fit: "131.34" }, expectedFactors: { AAWA: "83100" } },
  { year: 2024, label: "single with the Step 2 checkbox, weekly $1,500 — checkbox schedule",
    citation: P15T_2024,
    // 2g = 8,584.25 + 24% × (78,000 − 57,563) = 13,489.13; ÷ 52
    input: { payDate: "2024-01-12", periodsPerYear: 52, wages: "1500.00", filingStatus: "single", multipleJobs: true },
    expected: { fit: "259.41" }, expectedFactors: { AAWA: "78000" } },
  { year: 2024, label: "Social Security wage-base crossing and Additional Medicare trigger",
    citation: "SSA 2024 wage base $168,600 (FR 2023-23317); IRC §3101(b)(2)",
    input: { payDate: "2024-11-15", periodsPerYear: 24, wages: "3000.00", filingStatus: "single",
      ytd: { ssWages: "167000.00", medicareWages: "199000.00" } },
    expected: { ss: "99.20", ssEmployer: "99.20", medicare: "43.50", additionalMedicare: "18.00" } },
];

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const at = `${row.year} ${row.label} [${row.citation}]`;
    const result = calculatePub15T({ futaEffectiveRate: "0.006", ...row.input });
    for (const [key, want] of Object.entries(row.expected)) {
      assert.equal(result[key as ResultKey], money(want), `${at}: ${key}`);
    }
    for (const [key, want] of Object.entries(row.expectedFactors ?? {})) {
      assert.equal(result.factors[key], money(want), `${at}: factor ${key}`);
    }
  });
}

const REFUSALS: readonly { label: string; input: Pub15TInput; refusal: RegExp }[] = [
  { label: "a nonresident alien needs the Table 1 / Table 2 adjustment, refused by name",
    input: { ...biweekly2000("2026-12-15"), nonresidentAlien: true, futaEffectiveRate: undefined },
    refusal: /Federal withholding for a nonresident-alien employee requires the Pub\. 15-T Table 1 or Table 2.*refused by name/ },
  { label: "supplemental wages without regular FIT history refuse until the method-1b basis exists",
    input: { payDate: "2026-06-15", periodsPerYear: 12, wages: "0.00", supplemental: "1000.00", filingStatus: "single", noRegularFitWithheld: true },
    refusal: /cannot use the optional flat rate.*Pub\. 15 §7 requires method 1b.*supplementalRegularBasis.*refused by name/ },
  { label: "zero pay periods per year",
    input: { payDate: "2026-06-15", periodsPerYear: 0, wages: "30.00", filingStatus: "single" }, refusal: /invalid pay periods per year/ },
  { label: "2001 pay periods per year, past the highest documented frequency",
    input: { payDate: "2026-06-15", periodsPerYear: 2001, wages: "30.00", filingStatus: "single" }, refusal: /invalid pay periods per year/ },
];

for (const row of REFUSALS) {
  test(`2026 refusal: ${row.label}`, () => {
    assert.throws(() => calculatePub15T({ futaEffectiveRate: "0.006", ...row.input }), row.refusal, row.label);
  });
}

test("federal payroll requires a recorded W-4 alien status", () => {
  void PAYROLL_COUNTRY_PACKS;
  const certificate = payrollCertificate("US", "us_w4_tax_residency");
  const resolveStatus = (alienStatus?: string) => resolveCertificate({
    certificate,
    stored: alienStatus == null ? [] : [{
      certificateKey: certificate.key, effectiveFrom: "2026-01-01", answers: { alien_status: alienStatus },
    }],
    asOf: "2026-12-15",
  }).answers.alien_status;
  assert.throws(
    () => requireUsFederalAlienStatus(resolveStatus()),
    /US federal payroll cannot calculate without the employee's federal tax-residency status.*refused by name/,
  );
  assert.equal(requireUsFederalAlienStatus(resolveStatus("us_person_or_resident_alien")), false);
  assert.equal(requireUsFederalAlienStatus(resolveStatus("nonresident_alien")), true);
});

test("edition resolution: 2026, 2025 and 2024, refuses unknown years", () => {
  for (const year of [2024, 2025, 2026]) {
    assert.equal(ratesForPayDate(`${year}-01-01`).year, year);
    assert.equal(ratesForPayDate(`${year}-12-31`).year, year);
  }
  assert.throws(() => ratesForPayDate("2023-12-31"));
  assert.throws(() => ratesForPayDate("2027-01-01"));
});

test("prior-year Pub 15-T tables are transcribed, not scaffolded", () => {
  for (const [year, rates] of [[2024, RATES_2024], [2025, RATES_2025]] as const) {
    const unfilled = unfilledPaths(rates);
    assert.deepEqual(unfilled, [], `transcribe every ${year} figure from Pub 15-T — still unfilled: ${unfilled.join(", ")}`);
  }
});

// Printed table starts: STANDARD = standard deduction − Worksheet 1A line-1g
// adjustment (8,600 single/HoH, 12,900 MFJ); CHECKBOX = standard deduction ÷ 2.
const SCHEDULES = [
  { year: 2024, rates: RATES_2024, citation: "Rev. Proc. 2023-34 (14,600 / 29,200 / 21,900)",
    standard: ["6000", "16300", "13300"], checkbox: ["7300", "14600", "10950"] },
  { year: 2025, rates: RATES_2025, citation: "Rev. Proc. 2024-40 (15,000 / 30,000 / 22,500)",
    standard: ["6400", "17100", "13900"], checkbox: ["7500", "15000", "11250"] },
  { year: 2026, rates: RATES_2026, citation: "Rev. Proc. 2025-32 (16,100 / 32,200 / 24,150)",
    standard: ["7500", "19300", "15550"], checkbox: ["8050", "16100", "12075"] },
] as const;
const STATUSES = ["single", "married_joint", "head_household"] as const;

for (const { year, rates, citation, standard, checkbox } of SCHEDULES) {
  test(`${year} printed schedules start at the ${citation} brackets and are cumulative`, () => {
    STATUSES.forEach((status, i) => {
      assert.equal(rates.standard[status][1]!.atLeast, standard[i], `${year} standard/${status} start [${citation}]`);
      assert.equal(rates.checkbox[status][1]!.atLeast, checkbox[i], `${year} checkbox/${status} start [${citation}]`);
    });
    // tentative[i+1] = tentative[i] + rate[i] × (atLeast[i+1] − atLeast[i]). Each year's
    // single-filer checkbox schedule prints thresholds (and in 2024/2025 the top tentative)
    // rounded from half-dollar boundaries, so it may differ by rate × $0.50.
    for (const [kind, tables] of [["standard", rates.standard], ["checkbox", rates.checkbox]] as const) {
      for (const [status, schedule] of Object.entries(tables)) {
        for (let i = 0; i + 1 < schedule.length; i++) {
          const expected = Number(schedule[i]!.tentative)
            + Number(schedule[i]!.rate) * (Number(schedule[i + 1]!.atLeast) - Number(schedule[i]!.atLeast));
          const printed = Number(schedule[i + 1]!.tentative);
          const tolerance = kind === "checkbox" && status === "single" ? 0.2 : 0.005;
          assert.ok(Math.abs(printed - expected) <= tolerance, `${year} ${kind}/${status} row ${i + 1}: printed ${printed}, cumulative ${expected}`);
        }
      }
    }
  });
}

test("FUTA per-period ignores Schedule A: every state accrues the 0.6% default", () => {
  // Transcribed reductions (2025 CA 1.2%, 2024 CA/NY 0.9% — sources beside
  // FUTA_CREDIT_REDUCTION in pub15t.ts) price on the year-end true-up, never
  // here: $7,000 × 0.6% = $42.00 in every state and every transcribed year.
  for (const payDate of ["2024-12-31", "2025-12-31", "2026-12-31"]) {
    for (const state of US_STATES) {
      const result = calculatePub15T({ payDate, periodsPerYear: 26, wages: "7000.00", filingStatus: "single", futaRegion: state });
      assert.equal(result.futa, money("42.00"), `${payDate} ${state}`);
    }
  }
});

test("FUTA Schedule A true-up prices transcribed years state by state, refuses an untranscribed one", () => {
  // 2025: California 1.2% the only state (CT/NY repaid before 2025-11-10,
  // verified against https://www.irs.gov/pub/irs-prior/f940sa--2025.pdf).
  assert.equal(futaScheduleATrueUp(2025, { CA: "7000.00", TX: "7000.00" }), money("84.00"));
  // 2024: CA and NY at 0.9% (https://www.irs.gov/pub/irs-prior/f940sa--2024.pdf).
  assert.equal(futaScheduleATrueUp(2024, { CA: "7000.00", NY: "7000.00", TX: "7000.00" }), money("126.00"));
  // USDOL publishes in November: an earlier 2026 true-up would silently price zero.
  assert.throws(
    () => futaScheduleATrueUp(2026, { CA: "7000.00" }),
    /Form 940 year-end true-up refused.*FUTA credit-reduction rates for 2026 are not transcribed.*refused by name/,
  );
});

test("state coverage list is exactly the nine no-withholding states", () => {
  assert.deepEqual([...NO_WITHHOLDING_STATES].sort(), ["AK", "FL", "NH", "NV", "SD", "TN", "TX", "WA", "WY"]);
  for (const state of NO_WITHHOLDING_STATES) assert.ok((US_STATES as readonly string[]).includes(state));
  assert.equal(US_STATES.length, 51); // 50 states + DC
});
