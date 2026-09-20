/**
 * Revenu Québec TP-1015.F-V source-deduction constants for 2025.
 *
 * Source (fetched from revenuquebec.ca, not memory):
 *   TP-1015.F-V (2025-01) — "Formulas to Calculate Source Deductions and
 *   Contributions",
 *   revenuquebec.ca/documents/en/formulaires/tp/TP-1015.F-V(2025-01).pdf
 *   (no mid-year 2025 guide exists — 2025-07 and 2025-02 both 404 — so one
 *   version covers the whole year).
 *
 * Section map for every constant below:
 *   - brackets / rates / constants K ..... "Principal changes" table (p. 5) and
 *     s. 2.1.1 Step 2 (identical tables, printed twice).
 *   - creditRate 14% on E ................ s. 2.1.1 Step 2 (the 0.14 × E term).
 *   - basicPersonalAmount $18,571 ........ "Personal tax credit amounts" (p. 5)
 *     and s. 2.1.1 Step 2 variable E1 ("$18,571 … for an employee who … did
 *     not complete form TP-1015.3-V").
 *   - workersDeduction 6% / $1,420 ....... "Deduction for workers" (p. 6) and
 *     s. 2.1.1 Step 1 variable H ("(0.06 × D), up to a maximum of $1,420 ÷ P").
 *   - lumpSumThreshold $18,571 / 7% ...... "Gratuities and retroactive pay"
 *     (p. 6) and the s. 2.1.2 NOTE ("If the total of the annual salary or
 *     wages and the lump-sum payment is not more than $18,571 for the year,
 *     simply withhold 7% income tax from the lump-sum payment").
 *   - labourFundsCreditRate 15% .......... s. 2.1.1 Step 2 (the 0.15 × P × Q
 *     and 0.15 × P × Q1 terms); the $5,000 annual purchase cap is the NOTE
 *     under variables Q/Q1.
 *   - qppFirstAdditionalRate / qppTotalRate — s. 2.1.1 Step 1 variable CS
 *     (= C × (0.01 ÷ 0.0640) + C2). The full QPP data (rates, maxima,
 *     exemption) lives in engine/src/payroll/canada/rates.ts (QPP_2025: base
 *     5.40% + 1.00% = 6.40%, max $4,339.20) and matches this guide's "Québec
 *     Pension Plan contributions" table (p. 7) line for line — including the
 *     second-additional $396.00 and the QPIP table ($98,000 × 0.00494 =
 *     $484.12; × 0.00692 = $678.16), which cross-check the T4127 CSVs; it is
 *     not duplicated here.
 *
 * NOTE on the printed constants K: they are transcribed from the doubly-printed
 * table, not derived — no uniform rounding rule reproduces them from the
 * bracket arithmetic (K2 = 53,255 × 5% = 2,662.75 prints as 2,662, i.e. down,
 * while K3 = 2,662 + 106,495 × 5% = 7,986.75 prints as 7,987, i.e. up). The
 * engine stores K and never recomputes it, and Appendix 1 reproduces to the
 * penny with the stored values, so the generating rule is the guide's
 * business, not this module's.
 */
import type { QcEditionRates } from "./rates.ts";

export const QC_RATES_2025: QcEditionRates = {
  year: 2025,
  version: "2025-01",
  effectiveFrom: "2025-01-01",
  status: "published",
  // "Income tax rates, income thresholds and constants for 2025"
  // (TP-1015.F-V (2025-01), p. 5 / s. 2.1.1 Step 2). Indexation 2.85%.
  brackets: [
    { upTo: "53255", rate: "0.14", k: "0" },
    { upTo: "106495", rate: "0.19", k: "2662" },
    { upTo: "129590", rate: "0.24", k: "7987" },
    { upTo: null, rate: "0.2575", k: "10255" },
  ],
  creditRate: "0.14",
  basicPersonalAmount: "18571",
  workersDeductionRate: "0.06",
  workersDeductionMax: "1420",
  lumpSumThreshold: "18571",
  lumpSumRate: "0.07",
  labourFundsCreditRate: "0.15",
  labourFundsAnnualPurchaseCap: "5000",
  qppFirstAdditionalRate: "0.01",
  qppTotalRate: "0.0640",
};
