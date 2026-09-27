/**
 * TP-1015.F-V conformance goldens, 2024–2026.
 *
 * External goldens: Revenu Québec's OWN worked examples in each year's
 * TP-1015.F-V — Appendix 1 (income tax on regular payments, every phase of the
 * same employee's year), Appendix 2 (Method 2 on a retroactive payment) and
 * Appendix 3 (QPP across the maximum) — transcribed from the published PDFs.
 * The remaining rows are hand-worked through the guide's formulas (round at
 * each parenthesis), independent of the engine code.
 *
 * QPP is not computed by this engine: C and C2 arrive from the T4127 QPP arm.
 * A row carrying `qppFrom` also prices that arm and asserts it produces the
 * row's own C/C2 inputs, which holds the T4127 engine to Appendix 3.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unfilledPaths } from "../../unfilled.ts";
import { calculateT4127, type T4127Ytd } from "../t4127.ts";
import { calculateTp1015, type Tp1015Input, type Tp1015Result } from "./tp1015.ts";
import { qcRatesForPayDate } from "./rates.ts";
import { QC_RATES_2024 } from "./rates-2024.ts";
import { QC_RATES_2025 } from "./rates-2025.ts";

interface Golden {
  year: number;
  label: string;
  input: Tp1015Input;
  /** Money as 2dp (the engine's 4dp with "00" appended). */
  expected?: Partial<Record<"periodicTax" | "bonusTax" | "totalTax", string>>;
  expectedFactors?: Record<string, string>;
  /** Year-to-date QPP state from which the T4127 QPP arm must reproduce `input.qpp`/`qpp2`. */
  qppFrom?: T4127Ytd;
  citation: string;
}

const APP1 = (year: number) => `TP-1015.F-V (${year}-01) Appendix 1`;
const HAND = "hand-worked from TP-1015.F-V (2026-01)";

// 2024 Appendix 1: weekly $1,500, RPP $100, TP-1015.3-V line 10 = $21,830;
// H = min(0.06 × 1,500, 1,380 ÷ 52) = 26.54; Y = 0.19 × I − 2,589 − 3,056.20 − shares.
const y2024 = { periodsPerYear: 52, income: "1500.00", pensionDeductions: "100.00",
  pensionable: "1500.00", personalCredits: "21830.00" };
// 2025 and 2026 Appendix 1: biweekly $4,000, RPP $200, line 10 = $21,830.
const biweekly4000 = { periodsPerYear: 26, income: "4000.00", pensionDeductions: "200.00",
  pensionable: "4000.00", personalCredits: "21830.00" };
// FTQ $100 and Fondaction $150 per period while the share purchases run.
const shares = { ftqSharesPerPeriod: "100.00", fondactionSharesPerPeriod: "150.00" };
const monthly6000 = { payDate: "2026-03-31", periodsPerYear: 12, income: "6000.00",
  qpp: "359.63", pensionable: "6000.00" };

const GOLDENS: Golden[] = [
  // ── 2024 Appendix 1 ──────────────────────────────────────────────────────
  { year: 2024, label: "Appendix 1 periods 1–20", citation: APP1(2024),
    input: { payDate: "2024-01-15", ...y2024, qpp: "91.69", ...shares },
    expectedFactors: { QC_H: "26.54", QC_CSA: "14.33", QC_I: "70674.76", QC_Y: "5833.00" },
    expected: { periodicTax: "112.17", totalTax: "112.17" } },
  { year: 2024, label: "Appendix 1 periods 21–45 (shares done)", citation: APP1(2024),
    input: { payDate: "2024-06-15", ...y2024, qpp: "91.69" },
    expectedFactors: { QC_CSA: "14.33", QC_I: "70674.76", QC_Y: "7783.00" },
    expected: { periodicTax: "149.67" } },
  { year: 2024, label: "Appendix 1 period 46 (QPP max crossing)", citation: APP1(2024),
    input: { payDate: "2024-11-15", ...y2024, qpp: "33.95", qpp2: "20.00" },
    // CSA = 33.95 × (0.01 ÷ 0.0640) + 20 = 25.3046875 → 25.30.
    expectedFactors: { QC_CSA: "25.30", QC_I: "70104.32", QC_Y: "7674.62" },
    expected: { periodicTax: "147.59" } },
  { year: 2024, label: "Appendix 1 periods 47–48 (second-additional band)", citation: APP1(2024),
    input: { payDate: "2024-11-25", ...y2024, qpp: "0.00", qpp2: "60.00" },
    expectedFactors: { QC_CSA: "60.00", QC_I: "68299.92", QC_Y: "7331.78" },
    expected: { periodicTax: "141.00" } },
  { year: 2024, label: "Appendix 1 period 49 (QPP2 tail)", citation: APP1(2024),
    input: { payDate: "2024-12-05", ...y2024, qpp: "0.00", qpp2: "48.00" },
    expectedFactors: { QC_CSA: "48.00", QC_I: "68923.92", QC_Y: "7450.34" },
    expected: { periodicTax: "143.28" } },
  { year: 2024, label: "Appendix 1 periods 50–52 (maxima reached)", citation: APP1(2024),
    input: { payDate: "2024-12-25", ...y2024, qpp: "0.00", qpp2: "0.00" },
    expectedFactors: { QC_CSA: "0.00", QC_I: "71419.92", QC_Y: "7924.58" },
    expected: { periodicTax: "152.40" } },

  // ── 2025 Appendix 1 (H = min(240, 1,420 ÷ 26) = 54.62; K = 2,662) ───────
  { year: 2025, label: "Appendix 1 periods 1–17", citation: APP1(2025),
    input: { payDate: "2025-01-15", ...biweekly4000, qpp: "247.38", ...shares },
    expectedFactors: { QC_H: "54.62", QC_CSA: "38.65", QC_I: "96374.98", QC_Y: "11618.05" },
    expected: { periodicTax: "446.85", totalTax: "446.85" } },
  { year: 2025, label: "Appendix 1 period 18 (QPP max crossing)", citation: APP1(2025),
    input: { payDate: "2025-05-15", ...biweekly4000, qpp: "133.74", qpp2: "28.00", ...shares },
    expectedFactors: { QC_CSA: "48.90", QC_I: "96108.48", QC_Y: "11567.41" },
    expected: { periodicTax: "444.90" } },
  { year: 2025, label: "Appendix 1 periods 19–20 (second-additional band)", citation: APP1(2025),
    input: { payDate: "2025-06-15", ...biweekly4000, qpp: "0.00", qpp2: "160.00", ...shares },
    expectedFactors: { QC_CSA: "160.00", QC_I: "93219.88", QC_Y: "11018.58" },
    expected: { periodicTax: "423.79" } },
  { year: 2025, label: "Appendix 1 period 21 (shares done, QPP2 tail)", citation: APP1(2025),
    input: { payDate: "2025-08-15", ...biweekly4000, qpp: "0.00", qpp2: "48.00" },
    expectedFactors: { QC_CSA: "48.00", QC_I: "96131.88", QC_Y: "12546.86" },
    expected: { periodicTax: "482.57" } },
  { year: 2025, label: "Appendix 1 periods 22–26 (maxima reached)", citation: APP1(2025),
    input: { payDate: "2025-11-15", ...biweekly4000, qpp: "0.00", qpp2: "0.00" },
    expectedFactors: { QC_CSA: "0.00", QC_I: "97379.88", QC_Y: "12783.98" },
    expected: { periodicTax: "491.69" } },

  // ── 2026 Appendices 1–3 ──────────────────────────────────────────────────
  { year: 2026, label: "Appendix 1 phase 1 (periods 1–18)", citation: APP1(2026),
    input: { payDate: "2026-01-15", ...biweekly4000, qpp: "243.52", ...shares },
    expectedFactors: { QC_H: "55.77", QC_CSA: "38.65", QC_I: "96345.08", QC_Y: "11557.37" },
    expected: { periodicTax: "444.51", totalTax: "444.51" } },
  { year: 2026, label: "Appendix 1 phase 2 (period 19, QPP max crossing)",
    citation: `${APP1(2026)} (final A) and Appendix 3 (period 19 C/C2)`,
    input: { payDate: "2026-09-18", ...biweekly4000, qpp: "95.94", qpp2: "56.00", ...shares },
    qppFrom: { cpp: "4383.36", pensionable: "72000.00" },
    // The guide prints CSA 71.24, but its own formula gives 95.94 ÷ 6.30 + 56 = 71.23
    // under any half-up rounding; the engine follows the formula, and the cent
    // washes out in ÷ 26 to the published A = 438.32.
    expectedFactors: { QC_CS: "71.23", QC_I: "95498.00", QC_Y: "11396.42" },
    expected: { periodicTax: "438.32" } },
  { year: 2026, label: "Appendix 1 phase 3 (periods 20–21)",
    citation: `${APP1(2026)} and Appendix 3 (period 20 C/C2)`,
    input: { payDate: "2026-10-02", ...biweekly4000, qpp: "0.00", qpp2: "160.00", ...shares },
    qppFrom: { cpp: "4479.30", cpp2: "56.00", pensionable: "76000.00" },
    expectedFactors: { QC_CSA: "160.00", QC_I: "93189.98", QC_Y: "10957.90" },
    expected: { periodicTax: "421.46" } },
  { year: 2026, label: "Appendix 1 phase 4 (period 22)",
    citation: `${APP1(2026)} and Appendix 3 (period 22 C2 = min(416 − 376, 160))`,
    input: { payDate: "2026-10-16", ...biweekly4000, qpp: "0.00", qpp2: "40.00" },
    qppFrom: { cpp: "4479.30", cpp2: "376.00", pensionable: "84000.00" },
    expectedFactors: { QC_I: "96309.98", QC_Y: "12525.70" },
    expected: { periodicTax: "481.76" } },
  { year: 2026, label: "Appendix 1 phase 5 (last 4 periods)", citation: APP1(2026),
    input: { payDate: "2026-12-04", ...biweekly4000, qpp: "0.00" },
    expectedFactors: { QC_I: "97349.98", QC_Y: "12723.30" },
    expected: { periodicTax: "489.36" } },
  { year: 2026, label: "Appendix 2 (Method 2 retroactive pay)", citation: "TP-1015.F-V (2026-01) Appendix 2",
    // Weekly $1,500, RPP $100; a $4,000 retro with $400 of the $500 RPP against it.
    input: { payDate: "2026-05-15", periodsPerYear: 52, income: "1500.00", nonPeriodic: "4000.00",
      pensionDeductions: "100.00", nonPeriodicPensionDeductions: "400.00", qpp: "342.26",
      pensionable: "5500.00" },
    expectedFactors: { QC_H: "27.88", QC_CS: "54.33", QC_CSA: "14.82", QC_CSB: "39.51", QC_I2: "74140.09" },
    expected: { bonusTax: "676.49" } },

  // ── 2026 hand-worked ─────────────────────────────────────────────────────
  { year: 2026, label: "monthly $6,000, BPA default (19% bracket)", citation: HAND,
    // QPP exemption 3,500 ÷ 12 truncates to 291.66: C = 0.0630 × 5,708.34 = 359.63.
    input: monthly6000, qppFrom: {},
    expectedFactors: { QC_H: "120.83", QC_CSA: "57.08", QC_E: "18952.00", QC_I: "69865.08", QC_Y: "7904.09" },
    expected: { periodicTax: "658.67", totalTax: "658.67" } },
  { year: 2026, label: "monthly $10,000 (24% bracket)", citation: HAND,
    input: { payDate: "2026-02-27", periodsPerYear: 12, income: "10000.00", qpp: "611.63", pensionable: "10000.00" },
    // Y = 28,172.42 − 8,151 − 2,653.28 = 17,368.14; ÷ 12 = 1,447.345 → 1,447.35 half-up.
    expectedFactors: { QC_I: "117385.08" }, expected: { periodicTax: "1447.35" } },
  { year: 2026, label: "monthly $20,000, QPP maxed (top bracket)", citation: HAND,
    input: { payDate: "2026-11-30", periodsPerYear: 12, income: "20000.00", qpp: "0.00", pensionable: "20000.00" },
    expectedFactors: { QC_I: "238550.04" }, expected: { periodicTax: "4025.70" } },
  { year: 2026, label: "weekly $400: the 6% workers deduction binds below its cap", citation: HAND,
    input: { payDate: "2026-01-09", periodsPerYear: 52, income: "400.00", qpp: "20.96", pensionable: "400.00" },
    expectedFactors: { QC_H: "24.00", QC_CSA: "3.33", QC_Y: "59.76" }, expected: { periodicTax: "1.15" } },
  { year: 2026, label: "7% flat withholding on a lump sum under the threshold", citation: `${HAND} s. 2.1.2`,
    // 52 × 200 + 500 = 10,900 ≤ 18,952 → 0.07 × 500; periodic Y floors at 0 under the E credit.
    input: { payDate: "2026-06-12", periodsPerYear: 52, income: "200.00", nonPeriodic: "500.00",
      qpp: "39.86", pensionable: "700.00" },
    expectedFactors: { QC_CSA: "1.81" },
    expected: { periodicTax: "0.00", bonusTax: "35.00", totalTax: "35.00" } },
  { year: 2026, label: "E rounds to the nearest dollar: 18,951.50 halves up", citation: `${HAND} s. 2.1.1 Step 2`,
    input: { ...monthly6000, personalCredits: "18951.50" },
    expectedFactors: { QC_E: "18952.00", QC_Y: "7904.09" } },
  { year: 2026, label: "E rounds to the nearest dollar: 18,951.49 rounds down", citation: `${HAND} s. 2.1.1 Step 2`,
    input: { ...monthly6000, personalCredits: "18951.49" },
    expectedFactors: { QC_E: "18951.00", QC_Y: "7904.23" } },
  { year: 2026, label: "tax-exempt employee: zero withholding on salary, lump sum and L",
    citation: "TP-1015.F-V (2026-01) s. 2.1",
    input: { payDate: "2026-03-31", periodsPerYear: 12, income: "6000.00", nonPeriodic: "2000.00",
      qpp: "485.63", pensionable: "8000.00", additionalTaxPerPeriod: "50.00", taxExempt: true },
    expected: { periodicTax: "0.00", bonusTax: "0.00", totalTax: "0.00" } },
  { year: 2026, label: "additional per-period tax L applies when Y is nil", citation: "TP-1015.F-V (2026-01) s. 2.1.1 Step 3",
    input: { payDate: "2026-03-31", periodsPerYear: 26, income: "0.00", qpp: "0.00", pensionable: "0.00",
      additionalTaxPerPeriod: "25.00" },
    expected: { periodicTax: "25.00" } },
  { year: 2026, label: "J/J1 annual deductions and K1 authorized credits", citation: HAND,
    input: { ...monthly6000, annualDeductions: "3000.00", authorizedAnnualDeductions: "2000.00",
      authorizedAnnualCredits: "250.00" },
    expectedFactors: { QC_I: "64865.08", QC_Y: "6704.09" }, expected: { periodicTax: "558.67" } },
  { year: 2026, label: "guards: F exceeding G floors I and tax at zero", citation: HAND,
    input: { payDate: "2026-02-13", periodsPerYear: 52, income: "50.00", qpp: "0.00", pensionable: "50.00",
      pensionDeductions: "100.00" },
    expectedFactors: { QC_I: "0.00" }, expected: { periodicTax: "0.00", totalTax: "0.00" } },
];

const money = (value: string) => `${value}00`;

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const where = (key: string) => `${row.year} ${row.label}: ${key} (${row.citation})`;
    if (row.qppFrom) {
      const { payDate, periodsPerYear, income, qpp, qpp2 } = row.input;
      const qppArm = calculateT4127({ payDate, province: "QC", periodsPerYear, income,
        federalClaimCode: 1, ytd: row.qppFrom });
      assert.equal(qppArm.cpp, money(qpp), where("T4127 QPP C"));
      if (qpp2 !== undefined) assert.equal(qppArm.cpp2, money(qpp2), where("T4127 QPP C2"));
    }
    const result = calculateTp1015(row.input);
    for (const [key, want] of Object.entries(row.expected ?? {})) {
      assert.equal(result[key as keyof Tp1015Result], money(want), where(key));
    }
    for (const [key, want] of Object.entries(row.expectedFactors ?? {})) {
      assert.equal(result.factors[key], money(want), where(key));
    }
  });
}

test("edition resolution by pay date", () => {
  for (const [payDate, version] of [["2024-01-15", "2024-01"], ["2024-12-31", "2024-01"],
    ["2025-01-15", "2025-01"], ["2025-12-31", "2025-01"], ["2026-01-01", "2026-01"],
    ["2026-12-31", "2026-01"]] as const) {
    assert.equal(qcRatesForPayDate(payDate).version, version, `${payDate} resolves to TP-1015.F-V (${version})`);
  }
});

const REFUSALS: { label: string; payDate: string; refusal: RegExp }[] = [
  { label: "pay date after the last published edition", payDate: "2027-01-01",
    refusal: /no TP-1015\.F-V constants for pay date 2027-01-01/ },
  { label: "pay date before the first published edition", payDate: "2023-12-31",
    refusal: /no TP-1015\.F-V constants for pay date 2023-12-31/ },
];
for (const row of REFUSALS) {
  test(`refuses: ${row.label}`, () => {
    assert.throws(() => qcRatesForPayDate(row.payDate), row.refusal, row.label);
  });
}

test("every published edition's constants are transcribed, not scaffolded", () => {
  for (const [name, rates] of Object.entries({ QC_RATES_2024, QC_RATES_2025 })) {
    assert.deepEqual(unfilledPaths(rates), [], `transcribe every ${name} figure from TP-1015.F-V`);
  }
});
