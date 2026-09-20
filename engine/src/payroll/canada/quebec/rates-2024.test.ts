/**
 * TP-1015.F-V 2024 conformance goldens.
 *
 * External goldens: Revenu Québec's OWN worked examples in TP-1015.F-V
 * (2024-01) — Appendix 1 (income tax on regular payments, six phases of the
 * same employee's year) — transcribed from the published PDF, so any drift in
 * constants or rounding fails against the publication itself. Follows
 * engine/src/payroll/canada/quebec/tp1015.test.ts.
 *
 * Guide arithmetic for every phase (round at each parenthesis):
 *   H = min(0.06 × 1,500, 1,380 ÷ 52) = min(90, 26.5384…) = 26.54
 *   Y = (0.19 × I) − 2,589 − (0.14 × 21,830) − (0.15 × 52 × Q)
 *       − (0.15 × 52 × Q1); A = Y ÷ 52.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unfilledPaths } from "../../unfilled.ts";
import { calculateTp1015 } from "./tp1015.ts";
import { qcRatesForPayDate } from "./rates.ts";
import { QC_RATES_2024 } from "./rates-2024.ts";

test("2024 TP-1015.F-V constants are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(QC_RATES_2024);
  assert.deepEqual(
    unfilled, [],
    "transcribe every 2024 figure from TP-1015.F-V — still unfilled: " + unfilled.join(", "),
  );
  assert.equal(QC_RATES_2024.status, "published");
  assert.equal(QC_RATES_2024.version, "2024-01");
  assert.equal(qcRatesForPayDate("2024-01-15").year, 2024);
  assert.equal(qcRatesForPayDate("2024-12-31").version, "2024-01");
});

test("2024 constants match the publication's principal-changes tables", () => {
  // TP-1015.F-V (2024-01) p. 5: thresholds 51,780 / 103,545 / 126,000;
  // rates 14 / 19 / 24 / 25.75%; constants 0 / 2,589 / 7,766 / 9,971.
  assert.deepEqual(QC_RATES_2024.brackets.map((b) => [b.upTo, b.rate, b.k]), [
    ["51780", "0.14", "0"],
    ["103545", "0.19", "2589"],
    ["126000", "0.24", "7766"],
    [null, "0.2575", "9971"],
  ]);
  assert.equal(QC_RATES_2024.basicPersonalAmount, "18056"); // p. 5
  assert.equal(QC_RATES_2024.workersDeductionMax, "1380");  // p. 6
  assert.equal(QC_RATES_2024.lumpSumThreshold, "18056");    // p. 6
  // Step factors: worker 6%, credit 14% on E, labour-funds 15%, flat 7%,
  // CS ratio 1.00 / 6.40 — each behaviorally pinned by the appendix goldens
  // below, restated here so any digit change fails by name.
  assert.equal(QC_RATES_2024.workersDeductionRate, "0.06");
  assert.equal(QC_RATES_2024.creditRate, "0.14");
  assert.equal(QC_RATES_2024.labourFundsCreditRate, "0.15");
  assert.equal(QC_RATES_2024.lumpSumRate, "0.07");
  assert.equal(QC_RATES_2024.qppFirstAdditionalRate, "0.01");
  assert.equal(QC_RATES_2024.qppTotalRate, "0.0640");
});

/**
 * Appendix 1, periods 1–20 — weekly $1,500, RPP $100/week, TP-1015.3-V
 * line 10 = $21,830, FTQ $100 and Fondaction $150 per week for the first 20
 * weeks.
 *
 * Guide arithmetic (transcribed):
 *   C   = 91.69 (Appendix 3: 0.0640 × (1,500 − 67.30)); C2 = 0
 *   CSA = 91.69 × (0.01 / 0.0640) = 14.3265625 → 14.33
 *   I   = 52 × (1,500 − 100 − 26.54 − 14.33) = 52 × 1,359.13 = 70,674.76
 *   Y   = (0.19 × 70,674.76) − 2,589 − (0.14 × 21,830) − (0.15 × 52 × 100)
 *         − (0.15 × 52 × 150)
 *       = 13,428.20 − 2,589 − 3,056.20 − 780 − 1,170 = 5,833.00
 *   A   = 5,833.00 ÷ 52 = 112.17
 * Verified: published in TP-1015.F-V (2024-01) Appendix 1.
 */
test("Appendix 1 periods 1–20: A = 112.17", () => {
  const result = calculateTp1015({
    payDate: "2024-01-15", periodsPerYear: 52,
    income: "1500.00", pensionDeductions: "100.00",
    qpp: "91.69", pensionable: "1500.00",
    personalCredits: "21830.00",
    ftqSharesPerPeriod: "100.00", fondactionSharesPerPeriod: "150.00",
  });
  assert.equal(result.factors.QC_H, "26.5400");
  assert.equal(result.factors.QC_CSA, "14.3300");
  assert.equal(result.factors.QC_I, "70674.7600");
  assert.equal(result.factors.QC_Y, "5833.0000");
  assert.equal(result.periodicTax, "112.1700");
  assert.equal(result.totalTax, "112.1700");
});

/**
 * Appendix 1, periods 21–45 — the share purchases ended after week 20.
 *
 * Guide arithmetic (transcribed):
 *   Y   = 13,428.20 − 2,589 − 3,056.20 − 0 − 0 = 7,783.00
 *   A   = 7,783.00 ÷ 52 = 149.67
 * Verified: published in TP-1015.F-V (2024-01) Appendix 1.
 */
test("Appendix 1 periods 21–45 (shares done): A = 149.67", () => {
  const result = calculateTp1015({
    payDate: "2024-06-15", periodsPerYear: 52,
    income: "1500.00", pensionDeductions: "100.00",
    qpp: "91.69", pensionable: "1500.00",
    personalCredits: "21830.00",
  });
  assert.equal(result.factors.QC_CSA, "14.3300");
  assert.equal(result.factors.QC_I, "70674.7600");
  assert.equal(result.factors.QC_Y, "7783.0000");
  assert.equal(result.periodicTax, "149.6700");
});

/**
 * Appendix 1, period 46 — the QPP maximum is crossed: C is capped at the
 * remaining room (33.95) and C2 begins (20).
 *
 * Guide arithmetic (transcribed):
 *   CSA = 33.95 × (0.01 / 0.0640) + 20 = 5.3046875 + 20 = 25.3046875 → 25.30
 *   I   = 52 × (1,500 − 100 − 26.54 − 25.30) = 52 × 1,348.16 = 70,104.32
 *   Y   = (0.19 × 70,104.32) − 2,589 − 3,056.20 − 0 − 0
 *       = 13,319.82 − 5,645.20 = 7,674.62
 *   A   = 7,674.62 ÷ 52 = 147.59
 * Verified: published in TP-1015.F-V (2024-01) Appendix 1.
 */
test("Appendix 1 period 46 (QPP max crossing): A = 147.59", () => {
  const result = calculateTp1015({
    payDate: "2024-11-15", periodsPerYear: 52,
    income: "1500.00", pensionDeductions: "100.00",
    qpp: "33.95", qpp2: "20.00", pensionable: "1500.00",
    personalCredits: "21830.00",
  });
  assert.equal(result.factors.QC_CSA, "25.3000");
  assert.equal(result.factors.QC_I, "70104.3200");
  assert.equal(result.factors.QC_Y, "7674.6200");
  assert.equal(result.periodicTax, "147.5900");
});

/**
 * Appendix 1, periods 47–48 — C is maxed (0), the whole week sits in the
 * second-additional band (C2 = 60).
 *
 * Guide arithmetic (transcribed):
 *   CSA = 60
 *   I   = 52 × (1,500 − 100 − 26.54 − 60) = 52 × 1,313.46 = 68,299.92
 *   Y   = (0.19 × 68,299.92) − 2,589 − 3,056.20 = 12,976.98 − 5,645.20
 *       = 7,331.78
 *   A   = 7,331.78 ÷ 52 = 141.00 (the guide prints "$141")
 * Verified: published in TP-1015.F-V (2024-01) Appendix 1.
 */
test("Appendix 1 periods 47–48 (second-additional band): A = 141.00", () => {
  const result = calculateTp1015({
    payDate: "2024-11-25", periodsPerYear: 52,
    income: "1500.00", pensionDeductions: "100.00",
    qpp: "0.00", qpp2: "60.00", pensionable: "1500.00",
    personalCredits: "21830.00",
  });
  assert.equal(result.factors.QC_CSA, "60.0000");
  assert.equal(result.factors.QC_I, "68299.9200");
  assert.equal(result.factors.QC_Y, "7331.7800");
  assert.equal(result.periodicTax, "141.0000");
});

/**
 * Appendix 1, period 49 — the QPP2 maximum leaves C2 = 48 of room.
 *
 * Guide arithmetic (transcribed):
 *   CSA = 48
 *   I   = 52 × (1,500 − 100 − 26.54 − 48) = 52 × 1,325.46 = 68,923.92
 *   Y   = (0.19 × 68,923.92) − 2,589 − 3,056.20 = 13,095.54 − 5,645.20
 *       = 7,450.34
 *   A   = 7,450.34 ÷ 52 = 143.28
 * Verified: published in TP-1015.F-V (2024-01) Appendix 1.
 */
test("Appendix 1 period 49 (QPP2 tail): A = 143.28", () => {
  const result = calculateTp1015({
    payDate: "2024-12-05", periodsPerYear: 52,
    income: "1500.00", pensionDeductions: "100.00",
    qpp: "0.00", qpp2: "48.00", pensionable: "1500.00",
    personalCredits: "21830.00",
  });
  assert.equal(result.factors.QC_CSA, "48.0000");
  assert.equal(result.factors.QC_I, "68923.9200");
  assert.equal(result.factors.QC_Y, "7450.3400");
  assert.equal(result.periodicTax, "143.2800");
});

/**
 * Appendix 1, periods 50–52 — both QPP maxima reached (C = C2 = 0).
 *
 * Guide arithmetic (transcribed):
 *   I   = 52 × (1,500 − 100 − 26.54 − 0) = 52 × 1,373.46 = 71,419.92
 *   Y   = (0.19 × 71,419.92) − 2,589 − 3,056.20 = 13,569.78 − 5,645.20
 *       = 7,924.58
 *   A   = 7,924.58 ÷ 52 = 152.40
 * Verified: published in TP-1015.F-V (2024-01) Appendix 1.
 */
test("Appendix 1 periods 50–52 (maxima reached): A = 152.40", () => {
  const result = calculateTp1015({
    payDate: "2024-12-25", periodsPerYear: 52,
    income: "1500.00", pensionDeductions: "100.00",
    qpp: "0.00", qpp2: "0.00", pensionable: "1500.00",
    personalCredits: "21830.00",
  });
  assert.equal(result.factors.QC_CSA, "0.0000");
  assert.equal(result.factors.QC_I, "71419.9200");
  assert.equal(result.factors.QC_Y, "7924.5800");
  assert.equal(result.periodicTax, "152.4000");
});
