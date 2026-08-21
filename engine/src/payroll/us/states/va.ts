/**
 * Virginia income-tax withholding — Employer Withholding Instructions,
 * Formula Method, wages paid after July 1, 2025.
 *
 * Source (fetched from tax.virginia.gov, not memory):
 *   Income Tax Withholding Guide for Employers, Rev. 05/25 (form 2614086),
 *     https://www.tax.virginia.gov/sites/default/files/vatax-pdf/employer-withholding-instructions.pdf
 *     — "Formula for Computing Tax to be Withheld" (p. 21) effective for
 *       wages paid after July 1, 2025 (Taxable Year 2025 and after);
 *       standard deduction $8,750; personal/dependent exemption $930;
 *       age-65-and-over & blind exemption $800; the four-bracket schedule;
 *       John's worked example; Pay Period Conversion Table (Daily = 300);
 *       supplemental-wage election of a flat 5.75% (p. 19).
 *   Form VA-4, Employee's Virginia Income Tax Withholding Exemption Certificate,
 *     https://www.tax.virginia.gov/sites/default/files/taxforms/miscellaneous/any/va-4-any.pdf
 *     — lines 1(a)/1(b) exemptions, line 2 additional, lines 3–4 exempt.
 *     "If you do not file this form, your employer must withhold Virginia
 *     income tax as if you had no exemptions."
 *
 * The formula, verbatim from p. 21:
 *
 *   1. (G)P − [$8,750 + (E1 × $930) + (E2 × $800)] = T
 *   2. If T is not over $3,000:          W = 2% of T
 *      Over $3,000 but not over $5,000:  W = $60 + 3% of excess over $3,000
 *      Over $5,000 but not over $17,000: W = $120 + 5% of excess over $5,000
 *      Over $17,000:                     W = $720 + 5.75% of excess over $17,000
 *   3. W ÷ P = W/H
 *
 * John's example rounds 5.75% of $33,176 to the nearest dollar ($1,908)
 * before adding the $720 base, producing W = $2,628 and W/H = $109.50.
 * The guide itself says the wage-bracket tables "are approximate" and to
 * "use the formula below for exact amounts." The engine follows the formula
 * to the cent: 5.75% × $33,176 = $1,907.62, W = $2,627.62, W/H = $109.48.
 * The two-cent difference is documented in the conformance test so nobody
 * "fixes" the engine against the rounded example.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { certificateAmount, certificateCount, certificateFlag } from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/va.ts";

/** One band of the p. 21 formula: W = base + rate × (T − over), T not over `upTo`. */
export interface VaFormulaBand {
  /** Null on the top band. INCLUSIVE — "not over $17,000" is the prior band. */
  upTo: string | null;
  over: string;
  base: string;
  /** Publication percent, already shifted by `pctToRate`. */
  rate: string;
}

export interface VaYearRates {
  year: number;
  status: "published" | "draft";
  /** The $8,750 standard deduction in step 1. One figure — the formula does not split by filing status. */
  standardDeduction: string;
  /** E1 — personal and dependent exemptions, annual, each. */
  personalExemption: string;
  /** E2 — age 65 and over & blind exemptions, annual, each. */
  ageBlindExemption: string;
  formula: readonly VaFormulaBand[];
  /** Flat supplemental election, p. 19 — exported, not applied by `compute`. */
  supplementalRate: string;
}

export const VA_RATES_2026: VaYearRates = {
  year: 2026,
  status: "published",
  standardDeduction: "8750",
  personalExemption: "930",
  ageBlindExemption: "800",
  formula: [
    { upTo: "3000", over: "0", base: "0", rate: pctToRate("2") },
    { upTo: "5000", over: "3000", base: "60", rate: pctToRate("3") },
    { upTo: "17000", over: "5000", base: "120", rate: pctToRate("5") },
    { upTo: null, over: "17000", base: "720", rate: pctToRate("5.75") },
  ],
  supplementalRate: pctToRate("5.75"),
};

const VA_EDITIONS_BY_YEAR: Record<number, VaYearRates> = {
  [VA_RATES_2026.year]: VA_RATES_2026,
};

export const VA_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Virginia Employer Withholding Instructions, Formula Method (Rev. 05/25)",
  effectiveFrom: "2026-01-01",
  citation:
    "Virginia Department of Taxation, Income Tax Withholding Guide for Employers, Rev. 05/25 "
    + "(2614086), Formula for Computing Tax to be Withheld (p. 21) effective for wages paid "
    + "after July 1, 2025 — standard deduction $8,750, E1 $930, E2 $800; John's semi-monthly "
    + "example; Form VA-4",
  status: "published",
  region: "VA",
}];

export function vaRatesForPayDate(payDate: string): VaYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = VA_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(VA_WITHHOLDING, year);
  }
  return rates;
}

/** Step 2 of the p. 21 formula — annualized tax W from annualized taxable T. */
export function vaAnnualTax(taxable: bigint, rates: VaYearRates): { tax: bigint; bandOver: string } {
  if (taxable <= 0n) return { tax: 0n, bandOver: "0" };
  for (const band of rates.formula) {
    const ceiling = band.upTo == null ? null : U(band.upTo);
    if (ceiling == null || taxable <= ceiling) {
      const excess = max0(taxable - U(band.over));
      return { tax: U(band.base) + mulRateCents(excess, band.rate), bandOver: band.over };
    }
  }
  throw new Error(`no Virginia formula band covers annualized taxable wages of ${D(taxable)}`);
}

/**
 * The p. 19 flat 5.75% supplemental election.
 *
 * Exported rather than applied: the guide lets the employer choose this only
 * when the supplemental payment is made separately AND tax was withheld from
 * the regular wages. `compute` aggregates, which is always permitted.
 */
export function vaSupplementalFlat(payDate: string, supplemental: string): string {
  const rates = vaRatesForPayDate(payDate);
  return D(mulRateCents(max0(U(supplemental)), rates.supplementalRate));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = vaRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Virginia withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (
    certificateFlag(input.certificate, "exempt")
    || certificateFlag(input.certificate, "military_spouse_exempt")
  ) {
    trace("VA_EXEMPT", 1n);
    return { state: "VA", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // p. 19: add supplemental paid with regular wages and withhold on the total.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("VA_ANNUAL_WAGES", annualWages);

  // Default ZERO exemptions — VA-4: "as if you had no exemptions."
  const e1 = certificateCount(input.certificate, "personal_exemptions") ?? 0;
  const e2 = certificateCount(input.certificate, "age_blind_exemptions") ?? 0;
  const annualExemption = U(rates.standardDeduction)
    + U(rates.personalExemption) * BigInt(e1)
    + U(rates.ageBlindExemption) * BigInt(e2);
  trace("VA_ANNUAL_EXEMPTION", annualExemption);

  const taxable = max0(annualWages - annualExemption);
  trace("VA_TAXABLE", taxable);

  const { tax: annualTax, bandOver } = vaAnnualTax(taxable, rates);
  factors.VA_BAND_OVER = bandOver;
  trace("VA_ANNUAL_TAX", annualTax);

  const periodTax = divIntCents(annualTax, P);
  trace("VA_TAX", periodTax);

  // VA-4 line 2 — additional withholding, added AFTER the rate.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("VA_WITHHELD", total);

  return {
    state: "VA",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const VA_WITHHOLDING: UsStateWithholdingEngine = {
  state: "VA",
  label: "Virginia income tax",
  certificateKey: "us_va_va4",
  ratesModule: RATES_MODULE,
  editions: VA_TAX_YEAR_EDITIONS,
  // The formula annualizes, so any frequency computes. The conversion table
  // prints Daily = 300 (not 365); a caller using a 365-day daily payroll is
  // applying a P the formula accepts and the printed daily table does not use.
  printedPeriods: null,
  compute,
};
