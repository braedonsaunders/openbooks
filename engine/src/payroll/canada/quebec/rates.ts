/**
 * Revenu Québec TP-1015.F-V source-deduction constants, versioned by the
 * guide's own version stamp.
 *
 * Source (fetched from revenuquebec.ca, not memory):
 *   TP-1015.F-V (2026-01) — "Formulas to Calculate Source Deductions and
 *   Contributions", revenuquebec.ca/documents/en/formulaires/tp/TP-1015.F-V(2026-01).pdf
 *
 * Section map for every constant below:
 *   - brackets / rates / constants K ..... "Principal changes" table (p. 5) and
 *     s. 2.1.1 Step 2 (identical tables).
 *   - creditRate 14% on E ................ s. 2.1.1 Step 2 (the 0.14 × E term).
 *   - basicPersonalAmount $18,952 ........ "Personal tax credit amounts" (p. 5)
 *     and s. 2.1.1 Step 2 variable E1 ("$18,952 … for an employee who … did
 *     not complete form TP-1015.3-V").
 *   - workersDeduction 6% / $1,450 ....... "Deduction for workers" (p. 6) and
 *     s. 2.1.1 Step 1 variable H.
 *   - lumpSumThreshold $18,952 / 7% ...... "Gratuities and retroactive pay"
 *     (p. 6) and the s. 2.1.2 NOTE ("If the total of the annual salary or
 *     wages and the lump-sum payment is not more than $18,952 for the year,
 *     simply withhold 7% income tax from the lump-sum payment").
 *   - labourFundsCreditRate 15% .......... s. 2.1.1 Step 2 (the 0.15 × P × Q
 *     and 0.15 × P × Q1 terms); the $5,000 annual purchase cap is the NOTE
 *     under variables Q/Q1.
 *   - qppFirstAdditionalRate / qppTotalRate — s. 2.1.1 Step 1 variable CS
 *     (= C × (0.01 ÷ 0.0630) + C2). The full QPP data (rates, maxima,
 *     exemption) lives in engine/src/payroll/canada/rates.ts (QPP_2026) and
 *     matches this guide's "Québec Pension Plan contributions" table (p. 7)
 *     line for line; it is not duplicated here.
 *
 * Deliberately NOT represented, because this module refuses to guess:
 *   - s. 2.2 cumulative averaging (commission employees) — unimplemented, as
 *     T4127 Option 2 is.
 *   - s. 5 health services fund (employer contribution by total payroll) — an
 *     employer levy outside the source-deduction stub, published as a gap.
 */

import { QC_EXTRA_EDITIONS } from "./editions.ts";

/** Bracket: annual taxable income up to `upTo` (null = top) at `rate` with constant `k`. */
export interface QcTaxBracket {
  upTo: string | null;
  rate: string;
  k: string;
}

export interface QcEditionRates {
  year: number;
  /** Revenu Québec's own version stamp on the publication. */
  version: string;
  effectiveFrom: string;
  /**
   * `draft` = scaffolded by scripts/payroll-new-tax-year.ts with placeholder
   * figures, never calculable. Required, so a new edition answers the question
   * instead of looking published because the module exists.
   */
  status: "published" | "draft";
  /** s. 2.1.1 Step 2 — taxable income thresholds, rates T and constants K. */
  brackets: QcTaxBracket[];
  /** The rate applied to the personal tax credit value E (0.14 × E). */
  creditRate: string;
  /** E1 default when no TP-1015.3-V is on file — the basic personal amount. */
  basicPersonalAmount: string;
  /** Variable H: (rate × D), capped at max ÷ P per period. */
  workersDeductionRate: string;
  workersDeductionMax: string;
  /** s. 2.1.2 NOTE: at or below this annual total, lump sums withhold flat. */
  lumpSumThreshold: string;
  lumpSumRate: string;
  /** Labour-sponsored funds credit rate on Q (FTQ) and Q1 (Fondaction). */
  labourFundsCreditRate: string;
  /**
   * The Q/Q1 NOTE's cap on the year's share purchases. The formula itself
   * carries no cap term — 0.15 × P × Q legitimately annualizes past $5,000
   * (the guide's own Appendix 1 has P × (Q + Q1) = $6,500 against $5,000 of
   * actual purchases) — so this is documentation for the employer's input
   * discipline, never something the engine silently clamps.
   */
  labourFundsAnnualPurchaseCap: string;
  /** Variable CS ratio: first-additional QPP rate over the total QPP rate. */
  qppFirstAdditionalRate: string;
  qppTotalRate: string;
}

/** TP-1015.F-V (2026-01). One version covers the whole 2026 year. */
export const QC_RATES_2026: QcEditionRates = {
  year: 2026,
  version: "2026-01",
  effectiveFrom: "2026-01-01",
  status: "published",
  // "Taxable income thresholds, income tax rates and constants for 2026"
  // (TP-1015.F-V (2026-01), p. 5 / s. 2.1.1 Step 2).
  brackets: [
    { upTo: "54345", rate: "0.14", k: "0" },
    { upTo: "108680", rate: "0.19", k: "2717" },
    { upTo: "132245", rate: "0.24", k: "8151" },
    { upTo: null, rate: "0.2575", k: "10465" },
  ],
  creditRate: "0.14",
  basicPersonalAmount: "18952",
  workersDeductionRate: "0.06",
  workersDeductionMax: "1450",
  lumpSumThreshold: "18952",
  lumpSumRate: "0.07",
  labourFundsCreditRate: "0.15",
  labourFundsAnnualPurchaseCap: "5000",
  qppFirstAdditionalRate: "0.01",
  qppTotalRate: "0.0630",
};

/**
 * Every Revenu Québec edition the pack carries: the transcribed 2026 guide plus
 * whatever year modules exist on disk (`./editions.ts` is generated from them by
 * scripts/payroll-new-tax-year.ts). Newest first, so the resolver picks the
 * latest edition in force on a date.
 */
export const QC_EDITIONS: readonly QcEditionRates[] = [
  ...QC_EXTRA_EDITIONS, QC_RATES_2026,
].slice().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

/**
 * Resolve the TP-1015.F-V constants in force on a pay date.
 *
 * THROWS for any year without a transcribed publication — exactly as
 * `ratesForPayDate` does for T4127. Revenu Québec issues the guide annually
 * (and mid-year when rates change, as in 2023-07), so an unknown date means
 * nobody has transcribed the real formulas yet, and calculating with last
 * year's constants would be silent wrong money.
 *
 * A SCAFFOLDED edition is refused separately and more loudly: the module exists
 * and type-checks, so presence alone proves nothing about the figures in it.
 */
export function qcRatesForPayDate(payDate: string): QcEditionRates {
  const year = Number(payDate.slice(0, 4));
  const forYear = QC_EDITIONS.filter((edition) => edition.year === year);
  const edition = forYear.find((candidate) => payDate >= candidate.effectiveFrom);
  if (!edition) {
    throw new Error(
      `no TP-1015.F-V constants for pay date ${payDate} — add the Revenu Québec edition to `
      + "engine/src/payroll/canada/quebec/rates.ts",
    );
  }
  if (edition.status !== "published") {
    throw new Error(
      `the ${year} TP-1015.F-V constants are scaffolded but not transcribed — placeholder values `
      + "remain in engine/src/payroll/canada/quebec/rates-" + year + ".ts; fill them in from the "
      + "published guide and flip the edition to published",
    );
  }
  return edition;
}
