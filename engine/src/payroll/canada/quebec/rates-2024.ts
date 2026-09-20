/**
 * Revenu Québec TP-1015.F-V source-deduction constants for 2024.
 *
 * Source (fetched from revenuquebec.ca, not memory):
 *   TP-1015.F-V (2024-01) — "Formulas to Calculate Source Deductions and
 *   Contributions",
 *   revenuquebec.ca/documents/en/formulaires/tp/TP-1015.F-V(2024-01).pdf
 *   (no mid-year 2024 guide exists — 2024-07 404s — so one version covers
 *   the whole year).
 *
 * Section map for every constant below:
 *   - brackets / rates / constants K ..... "Principal changes" table (p. 5) and
 *     s. 2.1.1 Step 2 (identical tables, printed twice).
 *   - creditRate 14% on E ................ s. 2.1.1 Step 2 (the 0.14 × E term).
 *   - basicPersonalAmount $18,056 ........ "Personal tax credit amounts" (p. 5)
 *     and s. 2.1.1 Step 2 variable E1 ("$18,056 … for an employee who … did
 *     not complete form TP-1015.3-V").
 *   - workersDeduction 6% / $1,380 ....... "Deduction for employment income"
 *     (p. 6) and s. 2.1.1 Step 1 variable H ("(0.06 × D), up to a maximum of
 *     $1,380 / P").
 *   - lumpSumThreshold $18,056 / 7% ...... "Gratuities and retroactive pay"
 *     (p. 6) and the s. 2.1.2 NOTE ("If the total of the annual salary or
 *     wages and the lump-sum payment is not more than $18,056 for the year,
 *     simply withhold 7% income tax from the lump-sum payment").
 *   - labourFundsCreditRate 15% .......... s. 2.1.1 Step 2 (the 0.15 × P × Q
 *     and 0.15 × P × Q1 terms); the $5,000 annual purchase cap is the NOTE
 *     under variables Q/Q1.
 *   - qppFirstAdditionalRate / qppTotalRate — s. 2.1.1 Step 1 variable CS
 *     (= C × (0.01 / 0.0640) + C2). The full QPP data lives in
 *     engine/src/payroll/canada/rates.ts (QPP_2024: base 5.40% + 1.00% =
 *     6.40%, max $4,160.00; YAMPE $73,200 = 107% of YMPE, the first year of
 *     the second additional contribution) and matches this guide's "Québec
 *     Pension Plan contributions" table (p. 7) line for line — including the
 *     second-additional $188.00 and the QPIP table ($94,000 × 0.00494 =
 *     $464.36; × 0.00692 = $650.48), which cross-check the T4127 CSVs; it is
 *     not duplicated here.
 */
import type { QcEditionRates } from "./rates.ts";

export const QC_RATES_2024: QcEditionRates = {
  year: 2024,
  version: "2024-01",
  effectiveFrom: "2024-01-01",
  status: "published",
  // "Income tax rates, income thresholds and constants for 2024"
  // (TP-1015.F-V (2024-01), p. 5 / s. 2.1.1 Step 2). Indexation 5.08%.
  brackets: [
    { upTo: "51780", rate: "0.14", k: "0" },
    { upTo: "103545", rate: "0.19", k: "2589" },
    { upTo: "126000", rate: "0.24", k: "7766" },
    { upTo: null, rate: "0.2575", k: "9971" },
  ],
  creditRate: "0.14",
  basicPersonalAmount: "18056",
  workersDeductionRate: "0.06",
  workersDeductionMax: "1380",
  lumpSumThreshold: "18056",
  lumpSumRate: "0.07",
  labourFundsCreditRate: "0.15",
  labourFundsAnnualPurchaseCap: "5000",
  qppFirstAdditionalRate: "0.01",
  qppTotalRate: "0.0640",
};
