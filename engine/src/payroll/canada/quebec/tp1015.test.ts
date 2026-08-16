/**
 * TP-1015.F-V conformance tests.
 *
 * External goldens: Revenu Québec's OWN worked examples in TP-1015.F-V
 * (2026-01) — Appendix 1 (income tax on regular payments, five phases of the
 * same employee's year), Appendix 2 (Method 2 on a retroactive payment) and
 * Appendix 3 (QPP contributions across the maximum) — transcribed from the
 * published PDF, so any drift in constants or rounding fails against the
 * publication itself. WebRAS was not reachable from this environment; the
 * guide's appendices are the publication the calculator itself implements,
 * and each test states how it was verified. The remaining cases are fully
 * hand-worked through the guide's formulas in comments, independent of the
 * engine code (the anti-false-green rule).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateTp1015 } from "./tp1015.ts";
import { qcRatesForPayDate, QC_RATES_2026 } from "./rates.ts";
import { calculateT4127 } from "../t4127.ts";

test("edition resolution: 2026 resolves, unknown years refuse", () => {
  assert.equal(qcRatesForPayDate("2026-01-01").version, "2026-01");
  assert.equal(qcRatesForPayDate("2026-12-31").version, "2026-01");
  assert.throws(() => qcRatesForPayDate("2025-12-31"));
  assert.throws(() => qcRatesForPayDate("2027-01-01"));
});

test("2026 constants match the publication's principal-changes tables", () => {
  // TP-1015.F-V (2026-01) p. 5: thresholds 54,345 / 108,680 / 132,245;
  // rates 14 / 19 / 24 / 25.75%; constants 0 / 2,717 / 8,151 / 10,465.
  assert.deepEqual(QC_RATES_2026.brackets.map((b) => [b.upTo, b.rate, b.k]), [
    ["54345", "0.14", "0"],
    ["108680", "0.19", "2717"],
    ["132245", "0.24", "8151"],
    [null, "0.2575", "10465"],
  ]);
  assert.equal(QC_RATES_2026.basicPersonalAmount, "18952"); // p. 5
  assert.equal(QC_RATES_2026.workersDeductionMax, "1450");  // p. 6
  assert.equal(QC_RATES_2026.lumpSumThreshold, "18952");    // p. 6
});

/**
 * Appendix 1, phase 1 (pay periods 1–18) — the guide's own worked example.
 * Biweekly $4,000, RPP $200/period, TP-1015.3-V line 10 = $21,830, FTQ $100
 * and Fondaction $150 per period for the first 20 periods.
 *
 * Guide arithmetic (transcribed):
 *   H   = min(0.06 × 4,000, 1,450 ÷ 26) = 55.77
 *   C   = 243.52 (Appendix 3: 0.0630 × (4,000 − 134.61)); C2 = 0
 *   CSA = CS = 243.52 × (0.01 ÷ 0.0630) = 38.65
 *   I   = 26 × (4,000 − 200 − 55.77 − 38.65) = 26 × 3,705.58 = 96,345.08
 *   Y   = (0.19 × 96,345.08) − 2,717 − (0.14 × 21,830) − (0.15 × 26 × 100)
 *         − (0.15 × 26 × 150)
 *       = 18,305.57 − 2,717 − 3,056.20 − 390 − 585 = 11,557.37
 *   A   = 11,557.37 ÷ 26 = 444.51
 * Verified: published in TP-1015.F-V (2026-01) Appendix 1.
 */
test("Appendix 1 phase 1 (periods 1–18): A = 444.51", () => {
  const result = calculateTp1015({
    payDate: "2026-01-15", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "243.52", pensionable: "4000.00",
    personalCredits: "21830.00",
    ftqSharesPerPeriod: "100.00", fondactionSharesPerPeriod: "150.00",
  });
  assert.equal(result.factors.QC_H, "55.7700");
  assert.equal(result.factors.QC_CSA, "38.6500");
  assert.equal(result.factors.QC_I, "96345.0800");
  assert.equal(result.factors.QC_Y, "11557.3700");
  assert.equal(result.periodicTax, "444.5100");
  assert.equal(result.totalTax, "444.5100");
});

/**
 * Appendix 1, phase 2 (pay period 19) — the QPP maximum is crossed mid-year:
 * C is capped at the remaining room and C2 begins.
 *
 * Guide arithmetic: C = 95.94, C2 = 56 (Appendix 3, 19th period), and the
 * guide prints CSA = 71.24, I = 95,497.74, Y = 11,396.37, A = 438.32.
 *
 * DOCUMENTED APPENDIX ARTIFACT: the guide's own formula cannot produce its
 * printed CSA. CS = C × (0.01 ÷ 0.0630) + C2 = 95.94 ÷ 6.30 + 56
 * = 15.228571… + 56 → 15.23 + 56 = 71.23 under any single half-up rounding
 * (15.24 would require 95.94 × ratio ≥ 15.235, i.e. a ratio ≥ 0.158796; the
 * true ratio is 0.158730…). Every OTHER value in Appendix 1 reproduces
 * exactly under the round-each-parenthesis discipline (phases 1, 3, 4, 5
 * below), so the engine follows the formula:
 *   CSA = 71.23
 *   I   = 26 × (4,000 − 200 − 55.77 − 71.23) = 26 × 3,673.00 = 95,498.00
 *   Y   = (0.19 × 95,498.00) − 2,717 − 3,056.20 − 390 − 585
 *       = 18,144.62 − 6,748.20 = 11,396.42
 *   A   = 11,396.42 ÷ 26 = 438.3238 → 438.32
 * The one-cent CSA divergence washes out in the ÷ 26: the withheld amount
 * equals the guide's published A = 438.32 to the penny.
 * Verified: published in TP-1015.F-V (2026-01) Appendix 1 (final A), with
 * the intermediate divergence hand-worked above.
 */
test("Appendix 1 phase 2 (period 19, QPP max crossing): A = 438.32", () => {
  const result = calculateTp1015({
    payDate: "2026-09-18", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "95.94", qpp2: "56.00", pensionable: "4000.00",
    personalCredits: "21830.00",
    ftqSharesPerPeriod: "100.00", fondactionSharesPerPeriod: "150.00",
  });
  assert.equal(result.factors.QC_CS, "71.2300");
  assert.equal(result.factors.QC_I, "95498.0000");
  assert.equal(result.factors.QC_Y, "11396.4200");
  assert.equal(result.periodicTax, "438.3200"); // matches the published A
});

/**
 * Appendix 1, phase 3 (periods 20–21) — base QPP exhausted, C2 running.
 * Guide: CSA = 160 (CS = 0 + 160), I = 26 × 3,584.23 = 93,189.98,
 * Y = 17,706.10 − 2,717 − 3,056.20 − 390 − 585 = 10,957.90, A = 421.46.
 * Verified: published in TP-1015.F-V (2026-01) Appendix 1.
 */
test("Appendix 1 phase 3 (periods 20–21): A = 421.46", () => {
  const result = calculateTp1015({
    payDate: "2026-10-02", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "0.00", qpp2: "160.00", pensionable: "4000.00",
    personalCredits: "21830.00",
    ftqSharesPerPeriod: "100.00", fondactionSharesPerPeriod: "150.00",
  });
  assert.equal(result.factors.QC_CSA, "160.0000");
  assert.equal(result.factors.QC_I, "93189.9800");
  assert.equal(result.factors.QC_Y, "10957.9000");
  assert.equal(result.periodicTax, "421.4600");
});

/**
 * Appendix 1, phase 4 (period 22) — share purchases finished after period 20,
 * C2's last partial period (C2 = 40).
 * Guide: I = 26 × 3,704.23 = 96,309.98, Y = 18,298.90 − 2,717 − 3,056.20
 * = 12,525.70, A = 481.76.
 * Verified: published in TP-1015.F-V (2026-01) Appendix 1.
 */
test("Appendix 1 phase 4 (period 22): A = 481.76", () => {
  const result = calculateTp1015({
    payDate: "2026-10-16", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "0.00", qpp2: "40.00", pensionable: "4000.00",
    personalCredits: "21830.00",
  });
  assert.equal(result.factors.QC_I, "96309.9800");
  assert.equal(result.factors.QC_Y, "12525.7000");
  assert.equal(result.periodicTax, "481.7600");
});

/**
 * Appendix 1, phase 5 (last 4 periods) — QPP fully maxed, CS = 0.
 * Guide: I = 26 × 3,744.23 = 97,349.98, Y = 18,496.50 − 2,717 − 3,056.20
 * = 12,723.30, A = 489.36.
 * Verified: published in TP-1015.F-V (2026-01) Appendix 1.
 */
test("Appendix 1 phase 5 (last 4 periods): A = 489.36", () => {
  const result = calculateTp1015({
    payDate: "2026-12-04", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "0.00", pensionable: "4000.00",
    personalCredits: "21830.00",
  });
  assert.equal(result.factors.QC_I, "97349.9800");
  assert.equal(result.factors.QC_Y, "12723.3000");
  assert.equal(result.periodicTax, "489.3600");
});

/**
 * Appendix 2 — Method 2 on a retroactive payment. Weekly $1,500, RPP $100;
 * in period 20 a $4,000 retro is paid with $500 total RPP, $400 of it against
 * the retro.
 *
 * Guide arithmetic (transcribed):
 *   H   = min(0.06 × 1,500, 1,450 ÷ 52) = 27.88
 *   S3  = 5,500;  C = 0.0630 × (5,500 − 67.30) = 342.26;  C2 = 0
 *   CS  = 342.26 × (0.01 ÷ 0.0630) = 54.33
 *   CSA = 54.33 × (1,500 ÷ 5,500) = 14.82
 *   CSB = 54.33 × (4,000 ÷ 5,500) = 39.51
 *   I   = [52 × (1,500 − 100 − 27.88 − 14.82)] + (4,000 − 400) − 39.51
 *       = 70,579.60 + 3,600 − 39.51 = 74,140.09  →  T = 19%
 *   tax on retro = 0.19 × (3,600 − 39.51) = 676.49
 * Verified: published in TP-1015.F-V (2026-01) Appendix 2.
 */
test("Appendix 2 (Method 2 retroactive pay): bonus tax = 676.49", () => {
  const result = calculateTp1015({
    payDate: "2026-05-15", periodsPerYear: 52,
    income: "1500.00", nonPeriodic: "4000.00",
    pensionDeductions: "100.00", nonPeriodicPensionDeductions: "400.00",
    qpp: "342.26", pensionable: "5500.00",
  });
  assert.equal(result.factors.QC_H, "27.8800");
  assert.equal(result.factors.QC_CS, "54.3300");
  assert.equal(result.factors.QC_CSA, "14.8200");
  assert.equal(result.factors.QC_CSB, "39.5100");
  assert.equal(result.factors.QC_I2, "74140.0900");
  assert.equal(result.bonusTax, "676.4900");
});

/**
 * Appendix 3 cross-check — the QPP inputs this engine consumes come from the
 * T4127 engine, so the T4127 QPP arm is held to Revenu Québec's OWN QPP
 * example (TP-1015.F-V ss. 3.1 and T4127's QPP formulas are the same
 * statutes): biweekly $4,000, crossing the maximum at period 19.
 * Verified: published in TP-1015.F-V (2026-01) Appendix 3.
 */
test("Appendix 3 (QPP across the maximum) matches the T4127 QPP engine", () => {
  // Period 19: A5 = 4,383.36, S5 = 72,000 → C = 95.94, C2 = 56.
  const p19 = calculateT4127({
    payDate: "2026-09-18", province: "QC", periodsPerYear: 26,
    income: "4000.00", federalClaimCode: 1,
    ytd: { cpp: "4383.36", pensionable: "72000.00" },
  });
  assert.equal(p19.cpp, "95.9400");
  assert.equal(p19.cpp2, "56.0000");
  // Period 20: A5 = 4,479.30, A8 = 56, S5 = 76,000 → C = 0, C2 = 160.
  const p20 = calculateT4127({
    payDate: "2026-10-02", province: "QC", periodsPerYear: 26,
    income: "4000.00", federalClaimCode: 1,
    ytd: { cpp: "4479.30", cpp2: "56.00", pensionable: "76000.00" },
  });
  assert.equal(p20.cpp, "0.0000");
  assert.equal(p20.cpp2, "160.0000");
  // Period 22: A8 = 376, S5 = 84,000 → C2 = min(416 − 376, 160) = 40.
  const p22 = calculateT4127({
    payDate: "2026-10-16", province: "QC", periodsPerYear: 26,
    income: "4000.00", federalClaimCode: 1,
    ytd: { cpp: "4479.30", cpp2: "376.00", pensionable: "84000.00" },
  });
  assert.equal(p22.cpp, "0.0000");
  assert.equal(p22.cpp2, "40.0000");
});

/**
 * ANTI-FALSE-GREEN: monthly $6,000, no TP-1015.3-V on file (E defaults to the
 * $18,952 basic personal amount), no other deductions. Every step hand-worked
 * from TP-1015.F-V (2026-01), independent of the engine:
 *
 *   QPP (s. 3.1): exemption 3,500 ÷ 12 = 291.666… → truncate → 291.66
 *     C  = 0.0630 × (6,000 − 291.66) = 0.0630 × 5,708.34
 *        = 359.62542 → 359.63;  C2 = 0 (below the YMPE band)
 *   CS (s. 2.1.1): 359.63 × (0.01 ÷ 0.0630) = 359.63 ÷ 6.30
 *        = 57.08412… → 57.08;  CSA = CS = 57.08 (no lump sum)
 *   H:   min(0.06 × 6,000, 1,450 ÷ 12) = min(360, 120.8333… → 120.83)
 *        = 120.83
 *   I:   12 × (6,000 − 0 − 120.83 − 57.08) = 12 × 5,822.09 = 69,865.08
 *   bracket: 54,345 < I ≤ 108,680 → T = 0.19, K = 2,717
 *   T×I: 0.19 × 69,865.08 = 13,274.3652 → 13,274.37
 *   E credit: 0.14 × 18,952 = 2,653.28
 *   Y:   13,274.37 − 2,717 − 2,653.28 = 7,904.09
 *   A:   7,904.09 ÷ 12 = 658.67416… → 658.67
 * Verified: hand-worked (above); the QPP input cross-checked against
 * calculateT4127 in the same test.
 */
test("hand-worked: monthly $6,000, BPA default → A = 658.67", () => {
  const qpp = calculateT4127({
    payDate: "2026-03-31", province: "QC", periodsPerYear: 12,
    income: "6000.00", federalClaimCode: 1,
  });
  assert.equal(qpp.cpp, "359.6300"); // hand-worked above
  const result = calculateTp1015({
    payDate: "2026-03-31", periodsPerYear: 12,
    income: "6000.00", qpp: qpp.cpp, pensionable: "6000.00",
  });
  assert.equal(result.factors.QC_H, "120.8300");
  assert.equal(result.factors.QC_CSA, "57.0800");
  assert.equal(result.factors.QC_E, "18952.0000");
  assert.equal(result.factors.QC_I, "69865.0800");
  assert.equal(result.factors.QC_Y, "7904.0900");
  assert.equal(result.periodicTax, "658.6700");
  assert.equal(result.totalTax, "658.6700");
});

/**
 * Hand-worked: 24% bracket. Monthly $10,000, BPA default.
 *   C = 0.0630 × (10,000 − 291.66) = 0.0630 × 9,708.34 = 611.62542 → 611.63
 *   CS = 611.63 ÷ 6.30 = 97.08412… → 97.08;  H = 120.83
 *   I = 12 × (10,000 − 120.83 − 97.08) = 12 × 9,782.09 = 117,385.08
 *   bracket: 108,680 < I ≤ 132,245 → T = 0.24, K = 8,151
 *   0.24 × 117,385.08 = 28,172.4192 → 28,172.42
 *   Y = 28,172.42 − 8,151 − 2,653.28 = 17,368.14
 *   A = 17,368.14 ÷ 12 = 1,447.345 → 1,447.35 (half-up)
 * Verified: hand-worked.
 */
test("hand-worked: monthly $10,000 lands in the 24% bracket → A = 1,447.35", () => {
  const result = calculateTp1015({
    payDate: "2026-02-27", periodsPerYear: 12,
    income: "10000.00", qpp: "611.63", pensionable: "10000.00",
  });
  assert.equal(result.factors.QC_I, "117385.0800");
  assert.equal(result.periodicTax, "1447.3500");
});

/**
 * Hand-worked: top bracket, QPP already maxed (C and C2 arrive as 0 from the
 * capped QPP engine late in the year). Monthly $20,000, BPA default.
 *   CS = 0;  H = 120.83
 *   I = 12 × (20,000 − 120.83) = 12 × 19,879.17 = 238,550.04
 *   top bracket → T = 0.2575, K = 10,465
 *   0.2575 × 238,550.04 = 61,426.6353 → 61,426.64
 *   Y = 61,426.64 − 10,465 − 2,653.28 = 48,308.36
 *   A = 48,308.36 ÷ 12 = 4,025.6966… → 4,025.70
 * Verified: hand-worked.
 */
test("hand-worked: monthly $20,000, QPP maxed → A = 4,025.70", () => {
  const result = calculateTp1015({
    payDate: "2026-11-30", periodsPerYear: 12,
    income: "20000.00", qpp: "0.00", pensionable: "20000.00",
  });
  assert.equal(result.factors.QC_I, "238550.0400");
  assert.equal(result.periodicTax, "4025.7000");
});

/**
 * Hand-worked: the deduction for workers below its cap — 6% binds, not
 * $1,450 ÷ P. Weekly $400, BPA default.
 *   H = min(0.06 × 400 = 24.00, 1,450 ÷ 52 = 27.88) = 24.00
 *   C = 0.0630 × (400 − 67.30) = 0.0630 × 332.70 = 20.9601 → 20.96
 *   CS = 20.96 ÷ 6.30 = 3.32698… → 3.33
 *   I = 52 × (400 − 24 − 3.33) = 52 × 372.67 = 19,378.84 → T = 0.14, K = 0
 *   0.14 × 19,378.84 = 2,713.0376 → 2,713.04
 *   Y = 2,713.04 − 2,653.28 = 59.76;  A = 59.76 ÷ 52 = 1.14923… → 1.15
 * Verified: hand-worked.
 */
test("hand-worked: weekly $400 — the 6% workers deduction binds → A = 1.15", () => {
  const result = calculateTp1015({
    payDate: "2026-01-09", periodsPerYear: 52,
    income: "400.00", qpp: "20.96", pensionable: "400.00",
  });
  assert.equal(result.factors.QC_H, "24.0000");
  assert.equal(result.factors.QC_CSA, "3.3300");
  assert.equal(result.factors.QC_Y, "59.7600");
  assert.equal(result.periodicTax, "1.1500");
});

/**
 * Hand-worked: the 7% flat rule on lump sums (s. 2.1.2 NOTE) — annual salary
 * plus lump sums at or below $18,952. Weekly $200 + $500 bonus:
 *   52 × 200 + 500 = 10,900 ≤ 18,952 → tax on the lump sum = 0.07 × 500
 *   = 35.00. The periodic tax is nil (Y floors at 0: I = 52 × (200 − 12 −
 *   1.81) = 9,681.88; 0.14 × 9,681.88 = 1,355.46 < the 2,653.28 E credit).
 *   QPP on S3 = 700: C = 0.0630 × (700 − 67.30) = 39.8601 → 39.86;
 *   CS = 39.86 ÷ 6.3 = 6.32698… → 6.33; CSA = 6.33 × 200/700 = 1.80857 → 1.81.
 * Verified: hand-worked.
 */
test("hand-worked: 7% flat withholding on a lump sum under the threshold", () => {
  const result = calculateTp1015({
    payDate: "2026-06-12", periodsPerYear: 52,
    income: "200.00", nonPeriodic: "500.00",
    qpp: "39.86", pensionable: "700.00",
  });
  assert.equal(result.factors.QC_CSA, "1.8100");
  assert.equal(result.periodicTax, "0.0000");
  assert.equal(result.bonusTax, "35.0000"); // 7% × 500
  assert.equal(result.totalTax, "35.0000");
});

/**
 * E rounds to the nearest whole dollar, halves up (s. 2.1.1 Step 2).
 * Verified: rule transcribed from the publication; arithmetic hand-worked
 * (18,951.50 → 18,952 → credit 2,653.28; 18,951.49 → 18,951 → 2,653.14).
 */
test("E rounds to the nearest dollar, halves up", () => {
  const base = {
    payDate: "2026-03-31", periodsPerYear: 12,
    income: "6000.00", qpp: "359.63", pensionable: "6000.00",
  };
  const up = calculateTp1015({ ...base, personalCredits: "18951.50" });
  const down = calculateTp1015({ ...base, personalCredits: "18951.49" });
  assert.equal(up.factors.QC_E, "18952.0000");
  assert.equal(down.factors.QC_E, "18951.0000");
  // The cent of credit difference: Y(down) = Y(up) + (2,653.28 − 2,653.14).
  assert.equal(up.factors.QC_Y, "7904.0900");
  assert.equal(down.factors.QC_Y, "7904.2300");
});

/**
 * TP-1015.3-V exemption (s. 2.1 "Exemption from source deductions of income
 * tax"): no Québec income tax is withheld at all — periodic, lump-sum, or
 * additional. Statutory QPP/QPIP are unaffected (they are not computed here).
 * Verified: rule transcribed from the publication.
 */
test("tax-exempt employee: zero withholding on salary and lump sums", () => {
  const result = calculateTp1015({
    payDate: "2026-03-31", periodsPerYear: 12,
    income: "6000.00", nonPeriodic: "2000.00",
    qpp: "485.63", pensionable: "8000.00",
    additionalTaxPerPeriod: "50.00",
    taxExempt: true,
  });
  assert.equal(result.periodicTax, "0.0000");
  assert.equal(result.bonusTax, "0.0000");
  assert.equal(result.totalTax, "0.0000");
});

/**
 * L — additional per-period tax (s. 2.1.1 Step 3: A = (Y ÷ P) + L) applies
 * even when Y is nil. Verified: rule transcribed from the publication.
 */
test("additional per-period tax L applies when Y is nil", () => {
  const result = calculateTp1015({
    payDate: "2026-03-31", periodsPerYear: 26,
    income: "0.00", qpp: "0.00", pensionable: "0.00",
    additionalTaxPerPeriod: "25.00",
  });
  assert.equal(result.periodicTax, "25.0000");
});

/**
 * J and J1 (annual deductions) subtract from I identically; K1 (authorized
 * annual credits) subtracts from Y after the bracket constant.
 * Hand-worked from the monthly $6,000 base case (I = 69,865.08):
 *   J + J1 = 5,000 → I = 64,865.08 → T = 0.19
 *   0.19 × 64,865.08 = 12,324.3652 → 12,324.37
 *   Y = 12,324.37 − 2,717 − 250 − 2,653.28 = 6,704.09
 *   A = 6,704.09 ÷ 12 = 558.674… → 558.67
 * Verified: hand-worked.
 */
test("hand-worked: J/J1 deductions and K1 authorized credits", () => {
  const result = calculateTp1015({
    payDate: "2026-03-31", periodsPerYear: 12,
    income: "6000.00", qpp: "359.63", pensionable: "6000.00",
    annualDeductions: "3000.00", authorizedAnnualDeductions: "2000.00",
    authorizedAnnualCredits: "250.00",
  });
  assert.equal(result.factors.QC_I, "64865.0800");
  assert.equal(result.factors.QC_Y, "6704.0900");
  assert.equal(result.periodicTax, "558.6700");
});

/** Zero and negative guards: I and Y floor at zero, never negative tax. */
test("guards: tiny income yields zero, never negative", () => {
  const result = calculateTp1015({
    payDate: "2026-02-13", periodsPerYear: 52,
    income: "50.00", qpp: "0.00", pensionable: "50.00",
    pensionDeductions: "100.00", // F exceeds G — the parenthesis goes negative
  });
  assert.equal(result.factors.QC_I, "0.0000");
  assert.equal(result.periodicTax, "0.0000");
  assert.equal(result.totalTax, "0.0000");
});
