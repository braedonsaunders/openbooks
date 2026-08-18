/**
 * Illinois income tax withholding — Booklet IL-700-T, AUTOMATED PAYROLL METHOD.
 *
 * Source (fetched from tax.illinois.gov, not memory):
 *   Booklet IL-700-T (R-12/25), "2026 Illinois Withholding Tax Tables",
 *   effective January 1, 2026 — the automated payroll method formula (p. 4)
 *   and its worked Example B.
 *   Publication 130 (R-02/26), "Who is Required to Withhold Illinois Income
 *   Tax" — the no-certificate rule and the reciprocity rule.
 *   Form IL-W-4 (R-07/23) — the certificate's own fields.
 *   Informational Bulletin FY 2026-15 (December 2025) — the 2026 personal
 *   exemption amount of $2,925.
 *
 * The formula, verbatim from IL-700-T p. 4:
 *
 *   Tax withheld = .0495 × ( Wages −
 *       ((Line 1 allowances × $2,925) + (Line 2 allowances × $1,000))
 *       ÷ (number of pay periods in a year) )
 *
 * with Step 5 adding the Form IL-W-4 Line 3 additional amount AFTERWARDS —
 * outside the rate multiplication. That last detail matters and is easy to get
 * backwards: an extra $25 a period requested by the employee is $25, not
 * $25 × 4.95%.
 *
 * Two published methods exist and THEY DO NOT AGREE. IL-700-T's Example A runs
 * $300 weekly with two Line 1 and one Line 2 allowance through the printed
 * WAGE-BRACKET tables and gets $8.38; the same facts through the automated
 * formula give $8.33, because the bracket tables tax the midpoint of a $2 wage
 * band. Both are correct — the state publishes both and an employer elects one.
 * This engine implements the AUTOMATED method, which is the one written for
 * payroll systems, and its goldens are Example B (the automated example). The
 * $0.05 difference is documented here so nobody "fixes" the engine against the
 * wrong example later.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateCount, certificateFlag,
} from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/il.ts";

export interface IlYearRates {
  year: number;
  status: "published" | "draft";
  /** The flat individual income tax rate used for withholding. */
  rate: string;
  /** Form IL-W-4 Line 1 — the personal exemption, annual, per allowance. */
  line1Allowance: string;
  /** Form IL-W-4 Line 2 — the additional allowance, annual, per allowance. */
  line2Allowance: string;
  /**
   * The per-allowance Line 2 subtraction each printed WAGE-BRACKET table
   * carries in its header. Not used by the automated method — transcribed
   * because it is the only place the booklet states a pay-periods-per-year
   * divisor, and the conformance test re-derives the divisors from it.
   */
  printedLine2PerPeriod: Readonly<Record<string, string>>;
}

/**
 * 2026 — Booklet IL-700-T (R-12/25), effective January 1, 2026.
 *
 * "The income tax rate is 4.95 percent and the exemption allowance is $2,925."
 * (IL-700-T p. 3). The Line 2 allowance of $1,000 is stated in the automated
 * payroll method formula on p. 4.
 */
export const IL_RATES_2026: IlYearRates = {
  year: 2026,
  status: "published",
  rate: "0.0495",
  line1Allowance: "2925",
  line2Allowance: "1000",
  // Printed in each table's header: "For each allowance claimed on Line 2 of
  // Form IL-W-4, subtract: $x.xx".
  printedLine2PerPeriod: {
    daily: "0.14",
    weekly: "0.95",
    biweekly: "1.90",
    semimonthly: "2.06",
    monthly: "4.13",
  },
};

const IL_EDITIONS_BY_YEAR: Record<number, IlYearRates> = {
  [IL_RATES_2026.year]: IL_RATES_2026,
};

export const IL_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Booklet IL-700-T (R-12/25)",
  effectiveFrom: "2026-01-01",
  citation:
    "Illinois Department of Revenue, Booklet IL-700-T (R-12/25), 2026 Illinois Withholding Tax "
    + "Tables, automated payroll method (p. 4); Informational Bulletin FY 2026-15",
  status: "published",
  region: "IL",
}];

export function ilRatesForPayDate(payDate: string): IlYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = IL_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(IL_WITHHOLDING, year);
  }
  return rates;
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = ilRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Illinois withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const wages = U(input.wages) + U(input.supplemental ?? "0");

  // Pub 130 (R-02/26) p. 12: an employee with a filed IL-W-5-NR is withheld at
  // ZERO. That relief is resolved upstream by the reciprocity resolver, which
  // removes the Illinois levy from the plan entirely — this engine is only
  // called when Illinois withholding applies, so there is no second, divergent
  // copy of the rule here.
  //
  // The exempt box on the IL-W-4 itself is different: it is an assertion by the
  // employee about their own liability, so it belongs to the certificate.
  if (certificateFlag(input.certificate, "exempt")) {
    trace("IL_EXEMPT", 1n);
    return { state: "IL", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // Step 2. IL-W-4 Line 1 and Line 2 allowances.
  //
  // IL-W-4 (R-07/23): "If you do not file a completed Form IL-W-4 with your
  // employer … your employer must withhold Illinois Income Tax on the entire
  // amount of your compensation, without allowing any exemptions." Pub 130
  // restates it as "withhold … with no allowances". So the DEFAULT is zero, not
  // one — and it is the certificate's declared default, not an assumption made
  // here.
  const line1 = certificateCount(input.certificate, "line1_allowances") ?? 0;
  const line2 = certificateCount(input.certificate, "line2_allowances") ?? 0;

  const annualExemption = U(rates.line1Allowance) * BigInt(line1)
    + U(rates.line2Allowance) * BigInt(line2);
  trace("IL_ANNUAL_EXEMPTION", annualExemption);

  // Step 2d — divide by the pay periods in the year. Example B rounds the
  // quotient to the cent BEFORE subtracting ($7,850 ÷ 52 = 150.9615… printed as
  // $150.96, and $800 − $150.96 = $649.04 exactly as printed). Rounding after
  // the subtraction instead would give $649.0385 and a different final cent.
  const periodExemption = divIntCents(annualExemption, P);
  trace("IL_PERIOD_EXEMPTION", periodExemption);

  // Step 3. Taxable amount. Floored at zero: the booklet's tables never print a
  // negative and a negative would refund state tax the employer never withheld.
  const taxable = max0(wages - periodExemption);
  trace("IL_TAXABLE", taxable);

  // Step 4.
  const tax = mulRateCents(taxable, rates.rate);
  trace("IL_TAX", tax);

  // Step 5 — the Line 3 additional amount, added AFTER the rate.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = tax + extra;
  trace("IL_WITHHELD", total);

  return {
    state: "IL",
    year: rates.year,
    tax: D(total),
    // IL-700-T and Pub 130 print no supplemental-wage rule at all; Pub 130 p. 2
    // lists "bonus, overtime, and commission pay" as ordinary compensation. So
    // there is no separate supplemental computation to report, and inventing a
    // flat rate citing a rule that does not exist would be worse than none.
    taxSupplemental: D(0n),
    factors,
  };
}

export const IL_WITHHOLDING: UsStateWithholdingEngine = {
  state: "IL",
  label: "Illinois income tax",
  certificateKey: "us_il_ilw4",
  ratesModule: RATES_MODULE,
  editions: IL_TAX_YEAR_EDITIONS,
  // The automated payroll method is a formula with the pay periods as a
  // divisor, so any frequency computes.
  printedPeriods: null,
  compute,
};
