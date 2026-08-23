/**
 * Louisiana income-tax withholding — R-1306 computer formula (1/26).
 *
 * Source (fetched from dam.ldr.la.gov, not memory):
 *   R-1306, Louisiana Withholding Tables and Formulas (1/26),
 *     effective on or after January 1, 2026,
 *     https://dam.ldr.la.gov/taxforms/1306-1-26.pdf
 *     — 3.09% rate; standard deduction $12,875 (single / married-separate)
 *       or $25,750 (married-joint / QSS / HoH); official Examples 1–2
 *       ($13.98 / $111.54); negative intermediates treated as zero.
 *   Form R-1300 (L-4) (1/26) — Block A 0 / 1 / 2; missing L-4 → no
 *     standard deduction.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, type PayrollCertificate,
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

const RATES_MODULE = "engine/src/payroll/us/states/la.ts";

export type LaDeductionClaim = "0" | "1" | "2";

export interface LaYearRates {
  year: number;
  status: "published" | "draft";
  rate: string;
  singleStandardDeduction: string;
  marriedStandardDeduction: string;
}

export const LA_RATES_2026: LaYearRates = {
  year: 2026,
  status: "published",
  rate: pctToRate("3.09"),
  singleStandardDeduction: "12875",
  marriedStandardDeduction: "25750",
};

const LA_EDITIONS_BY_YEAR: Record<number, LaYearRates> = {
  [LA_RATES_2026.year]: LA_RATES_2026,
};

export const LA_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Louisiana R-1306 Withholding Tables and Formulas (1/26)",
  effectiveFrom: "2026-01-01",
  citation:
    "Louisiana Department of Revenue, R-1306 (1/26), Employer's Withholding "
    + "Tax Formula — 3.09%, $12,875 / $25,750 standard deduction, Examples 1–2 "
    + "($13.98 / $111.54)",
  status: "published",
  region: "LA",
}];

export function laRatesForPayDate(payDate: string): LaYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = LA_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(LA_WITHHOLDING, year);
  }
  return rates;
}

/**
 * R-1306: deduction per period is D/N, rounded to the cent the way the
 * publication prints 12,875/52 = 247.60 and 25,750/26 = 990.38. A negative
 * (S − D/N) is treated as zero.
 */
export function laDeductionPerPeriod(
  claim: LaDeductionClaim,
  periodsPerYear: number,
  rates: LaYearRates,
): bigint {
  if (claim === "0") return 0n;
  const annual = claim === "2" ? rates.marriedStandardDeduction : rates.singleStandardDeduction;
  return divIntCents(U(annual), periodsPerYear);
}

export function laPeriodTax(
  wages: bigint,
  claim: LaDeductionClaim,
  periodsPerYear: number,
  rates: LaYearRates,
): bigint {
  const deduction = laDeductionPerPeriod(claim, periodsPerYear, rates);
  const taxable = max0(wages - deduction);
  return mulRateCents(taxable, rates.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = laRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Louisiana withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  // Missing L-4: "the employer must withhold Louisiana income tax from the
  // employee's wages without any standard deduction."
  const claim = (certificateChoice(input.certificate, "standard_deduction") ?? "0") as LaDeductionClaim;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  trace("LA_WAGES", wages);

  const deduction = laDeductionPerPeriod(claim, P, rates);
  trace("LA_DEDUCTION", deduction);
  const taxable = max0(wages - deduction);
  trace("LA_TAXABLE", taxable);

  const periodTax = mulRateCents(taxable, rates.rate);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = max0(periodTax + extra);
  trace("LA_WITHHELD", total);

  return {
    state: "LA",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const LA_WITHHOLDING: UsStateWithholdingEngine = {
  state: "LA",
  label: "Louisiana income tax",
  certificateKey: "us_la_l4",
  ratesModule: RATES_MODULE,
  editions: LA_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Louisiana withholding declarations — Form L-4 (R-1300) and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form R-1300 (L-4), Employee's Withholding Certificate (1/26). */
export const LA_CERTIFICATE: PayrollCertificate = {
  key: "us_la_l4",
  form: "L-4",
  label: "Louisiana Employee's Withholding Certificate",
  scope: { level: "region", region: "LA" },
  purpose: "withholding",
  citation:
    "Louisiana Department of Revenue, R-1306 (1/26), Louisiana Withholding "
    + "Tables and Formulas; Form R-1300 (L-4) (1/26)",
  summary:
    "Sets the Block A standard-deduction claim (0, 1, or 2). If the employee "
    + "does not complete an L-4, R-1300 requires withholding with no standard "
    + "deduction.",
  storage: "certificate_rows",
  fields: [
    {
      key: "standard_deduction",
      label: "Block A — Standard deduction claimed",
      kind: "choice",
      default: "0",
      choices: [
        { value: "0", label: "0 — No standard deduction" },
        { value: "1", label: "1 — Single or married filing separately ($12,875)" },
        {
          value: "2",
          label: "2 — Married filing jointly, qualifying surviving spouse, or head of household ($25,750)",
        },
      ],
      help:
        "R-1306 formula 1 / 2 / 3. Anyone may use 0 or 1; anyone claiming 2 "
        + "must use the married-joint formula. Default 0 is R-1300's own rule "
        + "when no L-4 is on file — withhold without any standard deduction.",
    },
    {
      key: "additional_per_period",
      label: "L-4 adjustments — Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "An increase in the amount of tax to be withheld, entered on Form L-4. "
        + "Added AFTER the R-1306 computer formula. A decrease is not modeled "
        + "here because R-1306 pins only the formula result.",
    },
  ],
};

export const LA_REGION: PayrollRegionWithholding = {
  region: "LA",
  label: "Louisiana income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_la_l4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Louisiana Department of Revenue, R-1306 (1/26); Form R-1300 (L-4) (1/26)",
};
