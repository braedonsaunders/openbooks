/**
 * South Carolina income-tax withholding — WH-1603F 2026 formula.
 *
 * Source (fetched from dor.sc.gov, not memory):
 *   WH-1603F, 2026 SC Withholding Tax Formula,
 *     https://dor.sc.gov/sites/dor/files/forms/WH1603F_2026.pdf
 *     — $5,000 per allowance; standard deduction $0 at zero allowances,
 *       else 10% of annual wages up to $7,500; subtraction / addition
 *       methods; official $750 weekly / 3-allowance example ($549.90 /
 *       $10.58).
 *   SCDOR Withholding FAQs / WH-105 — no SC W-4 → zero allowances.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateCount, certificateFlag,
} from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/sc.ts";

export interface ScYearRates {
  year: number;
  status: "published" | "draft";
  allowance: string;
  standardDeductionRate: string;
  standardDeductionCap: string;
  firstBracketTo: string;
  secondBracketTo: string;
  secondRate: string;
  secondSubtract: string;
  thirdRate: string;
  thirdSubtract: string;
  thirdAdd: string;
}

export const SC_RATES_2026: ScYearRates = {
  year: 2026,
  status: "published",
  allowance: "5000",
  standardDeductionRate: pctToRate("10"),
  standardDeductionCap: "7500",
  firstBracketTo: "3640",
  secondBracketTo: "18230",
  secondRate: pctToRate("3"),
  secondSubtract: "109.20",
  thirdRate: pctToRate("6"),
  thirdSubtract: "656.10",
  thirdAdd: "437.70",
};

const SC_EDITIONS_BY_YEAR: Record<number, ScYearRates> = {
  [SC_RATES_2026.year]: SC_RATES_2026,
};

export const SC_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "WH-1603F 2026 SC Withholding Tax Formula",
  effectiveFrom: "2026-01-01",
  citation:
    "South Carolina Department of Revenue, WH-1603F, 2026 SC Withholding Tax Formula "
    + "— $5,000 per allowance, 10% / $7,500 standard deduction, subtraction and "
    + "addition methods, $750 weekly 3-allowance example",
  status: "published",
  region: "SC",
}];

export function scRatesForPayDate(payDate: string): ScYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = SC_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(SC_WITHHOLDING, year);
  }
  return rates;
}

export function scStandardDeduction(annualWages: bigint, allowances: number, rates: ScYearRates): bigint {
  if (allowances <= 0) return 0n;
  const tenPercent = mulRateCents(annualWages, rates.standardDeductionRate);
  const cap = U(rates.standardDeductionCap);
  return tenPercent < cap ? tenPercent : cap;
}

/** Addition method — the publication's own worked example uses this path. */
export function scAnnualTax(taxable: bigint, rates: ScYearRates): bigint {
  if (taxable < U(rates.firstBracketTo) || taxable === U("0")) return 0n;
  if (taxable < U(rates.secondBracketTo)) {
    return mulRateCents(taxable - U(rates.firstBracketTo), rates.secondRate);
  }
  return U(rates.thirdAdd) + mulRateCents(taxable - U(rates.secondBracketTo), rates.thirdRate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = scRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for South Carolina withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("SC_EXEMPT", 1n);
    return { state: "SC", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("SC_ANNUAL_WAGES", annualWages);

  const personal = U(rates.allowance) * BigInt(allowances);
  trace("SC_PERSONAL_ALLOWANCE", personal);
  const standard = scStandardDeduction(annualWages, allowances, rates);
  trace("SC_STANDARD_DEDUCTION", standard);

  const taxable = max0(annualWages - personal - standard);
  trace("SC_TAXABLE", taxable);

  const annualTax = scAnnualTax(taxable, rates);
  trace("SC_ANNUAL_TAX", annualTax);
  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("SC_WITHHELD", total);

  return {
    state: "SC",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const SC_WITHHOLDING: UsStateWithholdingEngine = {
  state: "SC",
  label: "South Carolina income tax",
  certificateKey: "us_sc_scw4",
  ratesModule: RATES_MODULE,
  editions: SC_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};
