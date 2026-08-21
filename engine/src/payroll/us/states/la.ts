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
  certificateAmount, certificateChoice,
} from "../../certificates.ts";
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
