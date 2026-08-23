/**
 * Kentucky income-tax withholding — 2026 Kentucky Withholding Tax Formula
 * (flat 3.5% after the standard deduction).
 *
 * Source (fetched from revenue.ky.gov, not memory):
 *   42A003 (TCF)(10-2025), "2026 KENTUCKY WITHHOLDING TAX FORMULA",
 *     https://revenue.ky.gov/Forms/2026%20Withholding%20Formula.pdf
 *     — standard deduction $3,360; tax rate 3.5% of taxable income; the
 *       annualized formula and both 2026 worked examples.
 *   Form 42A804 (K-4) (2026),
 *     https://revenue.ky.gov/Forms/42A804%20(K-4)%20(2026).pdf
 *     — the four exemption checkboxes and the additional-withholding line.
 *     "Form K-4 is only required to document that an employee has requested
 *     an exemption from withholding OR to document that an employee has
 *     requested additional withholding." With neither, the employer
 *     withholds the formula amount — there are no allowances to default.
 *
 * The formula, verbatim:
 *
 *   Wages for the pay period × annual pay periods = annual wages.
 *   Annual wages − the Kentucky standard deduction = annual Kentucky wages.
 *   3.5% of that = gross annual Kentucky tax.
 *   Divide by the number of annual pay periods = withholding for the period.
 *
 * The bi-weekly worked example prints a typo ("$35,730" for a figure it
 * itself computed as $35,640) and then prints "$47" for $1,247.40 ÷ 26,
 * which is $47.98 to the cent. The monthly example is internally consistent
 * and is the conformance golden. The engine follows the formula, not the
 * bi-weekly example's rounded $47.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateFlag, type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/ky.ts";

export interface KyYearRates {
  year: number;
  status: "published" | "draft";
  /** "2026 Kentucky Tax Rate: 3.5% of taxable income". */
  rate: string;
  /** "2026 Kentucky Standard Deduction: $3,360". */
  standardDeduction: string;
}

export const KY_RATES_2026: KyYearRates = {
  year: 2026,
  status: "published",
  rate: pctToRate("3.5"),
  standardDeduction: "3360",
};

const KY_EDITIONS_BY_YEAR: Record<number, KyYearRates> = {
  [KY_RATES_2026.year]: KY_RATES_2026,
};

export const KY_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "42A003 (TCF)(10-2025) 2026 Kentucky Withholding Tax Formula",
  effectiveFrom: "2026-01-01",
  citation:
    "Kentucky Department of Revenue, 42A003 (TCF)(10-2025), 2026 Kentucky Withholding Tax "
    + "Formula — standard deduction $3,360, flat rate 3.5%, monthly and bi-weekly worked "
    + "examples; Form 42A804 (K-4) (2026)",
  status: "published",
  region: "KY",
}];

export function kyRatesForPayDate(payDate: string): KyYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = KY_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(KY_WITHHOLDING, year);
  }
  return rates;
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = kyRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Kentucky withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("KY_EXEMPT", 1n);
    return { state: "KY", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // 42A003 does not print a separate supplemental-wage rule. The period's
  // wages — regular plus any supplemental paid with them — are annualized
  // together, which is the formula as written.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("KY_ANNUAL_WAGES", annualWages);

  const taxable = max0(annualWages - U(rates.standardDeduction));
  trace("KY_TAXABLE", taxable);

  const annualTax = mulRateCents(taxable, rates.rate);
  trace("KY_ANNUAL_TAX", annualTax);

  const periodTax = divIntCents(annualTax, P);
  trace("KY_TAX", periodTax);

  // K-4 "Additional withholding per pay period" — added AFTER the rate.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("KY_WITHHELD", total);

  return {
    state: "KY",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const KY_WITHHOLDING: UsStateWithholdingEngine = {
  state: "KY",
  label: "Kentucky income tax",
  certificateKey: "us_ky_k4",
  ratesModule: RATES_MODULE,
  editions: KY_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Kentucky withholding declarations — Form K-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form 42A804 (K-4) (2026). */
export const KY_CERTIFICATE: PayrollCertificate = {
  key: "us_ky_k4",
  form: "K-4",
  label: "Kentucky's Withholding Certificate",
  scope: { level: "region", region: "KY" },
  purpose: "withholding",
  citation:
    "Kentucky Form 42A804 (K-4) (2026); 42A003 (TCF)(10-2025) 2026 Kentucky Withholding Tax Formula",
  summary:
    "Documents an exemption from Kentucky withholding or a request for additional withholding. "
    + "\"If neither situation applies, then an employer is not required to maintain Form K-4.\" "
    + "The formula itself has no allowances — every wage earner is taxed at 3.5% after the "
    + "$3,360 standard deduction.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exempt",
      label: "Exempt from Kentucky withholding",
      kind: "flag",
      help:
        "K-4 boxes 1–4: no 2026 Kentucky income-tax liability expected; Fort Campbell "
        + "nonresident exemption; nonresident military-spouse (SCRA); or resident of a "
        + "reciprocal state (IL, IN, MI, WV, WI; VA with a daily commute; OH if not a "
        + "20%-or-greater S-corporation shareholder-employee). Any one box stops withholding. "
        + "The exemption must be on file before withholding can be stopped.",
    },
    {
      key: "additional_per_period",
      label: "Additional withholding per pay period under agreement with employer",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the 3.5% formula — a flat dollar amount, not a taxable adjustment.",
    },
  ],
};

export const KY_REGION: PayrollRegionWithholding = {
  region: "KY",
  label: "Kentucky income tax",
  implemented: true,
  // KRS 141 and the Department's employer page: withhold for resident and
  // nonresident employees unless a published exemption applies.
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by 42A003: whether a Kentucky resident's wages earned
  // entirely outside Kentucky must be withheld on. Declared unknown.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ky_k4",
  // Kentucky cities levy occupational-license / payroll taxes that are not
  // the state income tax and are not in 42A003. They are not modelled here.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Kentucky Department of Revenue, 42A003 (TCF)(10-2025), 2026 Kentucky Withholding Tax "
    + "Formula; Form 42A804 (K-4) (2026)",
};
