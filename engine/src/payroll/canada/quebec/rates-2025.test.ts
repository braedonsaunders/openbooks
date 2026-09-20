/**
 * TP-1015.F-V 2025 conformance goldens.
 *
 * External goldens: Revenu Québec's OWN worked examples in TP-1015.F-V
 * (2025-01) — Appendix 1 (income tax on regular payments, five phases of the
 * same employee's year) — transcribed from the published PDF, so any drift in
 * constants or rounding fails against the publication itself. Follows
 * engine/src/payroll/canada/quebec/tp1015.test.ts.
 *
 * Guide arithmetic for every phase (round at each parenthesis):
 *   H = min(0.06 × 4,000, 1,420 ÷ 26) = min(240, 54.6153…) = 54.62
 *   Y = (0.19 × I) − 2,662 − (0.14 × 21,830) − (0.15 × 26 × Q)
 *       − (0.15 × 26 × Q1); A = Y ÷ 26.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unfilledPaths } from "../../unfilled.ts";
import { calculateTp1015 } from "./tp1015.ts";
import { qcRatesForPayDate } from "./rates.ts";
import { QC_RATES_2025 } from "./rates-2025.ts";

test("2025 TP-1015.F-V constants are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(QC_RATES_2025);
  assert.deepEqual(
    unfilled, [],
    "transcribe every 2025 figure from TP-1015.F-V — still unfilled: " + unfilled.join(", "),
  );
  assert.equal(QC_RATES_2025.status, "published");
  assert.equal(QC_RATES_2025.version, "2025-01");
  assert.equal(qcRatesForPayDate("2025-01-15").year, 2025);
  assert.equal(qcRatesForPayDate("2025-12-31").version, "2025-01");
});

test("2025 constants match the publication's principal-changes tables", () => {
  // TP-1015.F-V (2025-01) p. 5: thresholds 53,255 / 106,495 / 129,590;
  // rates 14 / 19 / 24 / 25.75%; constants 0 / 2,662 / 7,987 / 10,255.
  assert.deepEqual(QC_RATES_2025.brackets.map((b) => [b.upTo, b.rate, b.k]), [
    ["53255", "0.14", "0"],
    ["106495", "0.19", "2662"],
    ["129590", "0.24", "7987"],
    [null, "0.2575", "10255"],
  ]);
  assert.equal(QC_RATES_2025.basicPersonalAmount, "18571"); // p. 5
  assert.equal(QC_RATES_2025.workersDeductionMax, "1420");  // p. 6
  assert.equal(QC_RATES_2025.lumpSumThreshold, "18571");    // p. 6
  // Step factors: worker 6%, credit 14% on E, labour-funds 15%, flat 7%,
  // CS ratio 1.00 / 6.40 — each behaviorally pinned by the appendix goldens
  // below, restated here so any digit change fails by name.
  assert.equal(QC_RATES_2025.workersDeductionRate, "0.06");
  assert.equal(QC_RATES_2025.creditRate, "0.14");
  assert.equal(QC_RATES_2025.labourFundsCreditRate, "0.15");
  assert.equal(QC_RATES_2025.lumpSumRate, "0.07");
  assert.equal(QC_RATES_2025.qppFirstAdditionalRate, "0.01");
  assert.equal(QC_RATES_2025.qppTotalRate, "0.0640");
});

/**
 * Appendix 1, periods 1–17 — biweekly $4,000, RPP $200/period, TP-1015.3-V
 * line 10 = $21,830, FTQ $100 and Fondaction $150 per period.
 *
 * Guide arithmetic (transcribed):
 *   C   = 247.38 (Appendix 3: 0.0640 × (4,000 − 134.61)); C2 = 0
 *   CSA = 247.38 × (0.01 ÷ 0.0640) = 38.653125 → 38.65
 *   I   = 26 × (4,000 − 200 − 54.62 − 38.65) = 26 × 3,706.73 = 96,374.98
 *   Y   = (0.19 × 96,374.98) − 2,662 − (0.14 × 21,830) − (0.15 × 26 × 100)
 *         − (0.15 × 26 × 150)
 *       = 18,311.25 − 2,662 − 3,056.20 − 390 − 585 = 11,618.05
 *   A   = 11,618.05 ÷ 26 = 446.85
 * Verified: published in TP-1015.F-V (2025-01) Appendix 1.
 */
test("Appendix 1 periods 1–17: A = 446.85", () => {
  const result = calculateTp1015({
    payDate: "2025-01-15", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "247.38", pensionable: "4000.00",
    personalCredits: "21830.00",
    ftqSharesPerPeriod: "100.00", fondactionSharesPerPeriod: "150.00",
  });
  assert.equal(result.factors.QC_H, "54.6200");
  assert.equal(result.factors.QC_CSA, "38.6500");
  assert.equal(result.factors.QC_I, "96374.9800");
  assert.equal(result.factors.QC_Y, "11618.0500");
  assert.equal(result.periodicTax, "446.8500");
  assert.equal(result.totalTax, "446.8500");
});

/**
 * Appendix 1, period 18 — the QPP maximum is crossed: C is capped at the
 * remaining room (133.74) and C2 begins (28).
 *
 * Guide arithmetic (transcribed):
 *   CSA = 133.74 × (0.01 ÷ 0.0640) + 28 = 20.896875 + 28 = 48.896875 → 48.90
 *   I   = 26 × (4,000 − 200 − 54.62 − 48.90) = 26 × 3,696.48 = 96,108.48
 *   Y   = (0.19 × 96,108.48) − 2,662 − 3,056.20 − 390 − 585
 *       = 18,260.61 − 6,693.20 = 11,567.41
 *   A   = 11,567.41 ÷ 26 = 444.90
 * Verified: published in TP-1015.F-V (2025-01) Appendix 1.
 */
test("Appendix 1 period 18 (QPP max crossing): A = 444.90", () => {
  const result = calculateTp1015({
    payDate: "2025-05-15", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "133.74", qpp2: "28.00", pensionable: "4000.00",
    personalCredits: "21830.00",
    ftqSharesPerPeriod: "100.00", fondactionSharesPerPeriod: "150.00",
  });
  assert.equal(result.factors.QC_CSA, "48.9000");
  assert.equal(result.factors.QC_I, "96108.4800");
  assert.equal(result.factors.QC_Y, "11567.4100");
  assert.equal(result.periodicTax, "444.9000");
});

/**
 * Appendix 1, periods 19–20 — C is maxed (0), the whole period sits in the
 * second-additional band (C2 = 160).
 *
 * Guide arithmetic (transcribed):
 *   CSA = 0 × ratio + 160 = 160
 *   I   = 26 × (4,000 − 200 − 54.62 − 160) = 26 × 3,585.38 = 93,219.88
 *   Y   = (0.19 × 93,219.88) − 2,662 − 3,056.20 − 390 − 585
 *       = 17,711.78 − 6,693.20 = 11,018.58
 *   A   = 11,018.58 ÷ 26 = 423.79
 * Verified: published in TP-1015.F-V (2025-01) Appendix 1.
 */
test("Appendix 1 periods 19–20 (second-additional band): A = 423.79", () => {
  const result = calculateTp1015({
    payDate: "2025-06-15", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "0.00", qpp2: "160.00", pensionable: "4000.00",
    personalCredits: "21830.00",
    ftqSharesPerPeriod: "100.00", fondactionSharesPerPeriod: "150.00",
  });
  assert.equal(result.factors.QC_CSA, "160.0000");
  assert.equal(result.factors.QC_I, "93219.8800");
  assert.equal(result.factors.QC_Y, "11018.5800");
  assert.equal(result.periodicTax, "423.7900");
});

/**
 * Appendix 1, period 21 — the share purchases ended after period 20, and the
 * QPP2 maximum leaves C2 = 48 of room.
 *
 * Guide arithmetic (transcribed):
 *   CSA = 48
 *   I   = 26 × (4,000 − 200 − 54.62 − 48) = 26 × 3,697.38 = 96,131.88
 *   Y   = (0.19 × 96,131.88) − 2,662 − 3,056.20 − 0 − 0
 *       = 18,265.06 − 5,718.20 = 12,546.86
 *   A   = 12,546.86 ÷ 26 = 482.57
 * Verified: published in TP-1015.F-V (2025-01) Appendix 1.
 */
test("Appendix 1 period 21 (shares done, QPP2 tail): A = 482.57", () => {
  const result = calculateTp1015({
    payDate: "2025-08-15", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "0.00", qpp2: "48.00", pensionable: "4000.00",
    personalCredits: "21830.00",
  });
  assert.equal(result.factors.QC_CSA, "48.0000");
  assert.equal(result.factors.QC_I, "96131.8800");
  assert.equal(result.factors.QC_Y, "12546.8600");
  assert.equal(result.periodicTax, "482.5700");
});

/**
 * Appendix 1, periods 22–26 — both QPP maxima reached (C = C2 = 0).
 *
 * Guide arithmetic (transcribed):
 *   I   = 26 × (4,000 − 200 − 54.62 − 0) = 26 × 3,745.38 = 97,379.88
 *   Y   = (0.19 × 97,379.88) − 2,662 − 3,056.20 = 18,502.18 − 5,718.20
 *       = 12,783.98
 *   A   = 12,783.98 ÷ 26 = 491.69
 * Verified: published in TP-1015.F-V (2025-01) Appendix 1.
 */
test("Appendix 1 periods 22–26 (maxima reached): A = 491.69", () => {
  const result = calculateTp1015({
    payDate: "2025-11-15", periodsPerYear: 26,
    income: "4000.00", pensionDeductions: "200.00",
    qpp: "0.00", qpp2: "0.00", pensionable: "4000.00",
    personalCredits: "21830.00",
  });
  assert.equal(result.factors.QC_CSA, "0.0000");
  assert.equal(result.factors.QC_I, "97379.8800");
  assert.equal(result.factors.QC_Y, "12783.9800");
  assert.equal(result.periodicTax, "491.6900");
});
