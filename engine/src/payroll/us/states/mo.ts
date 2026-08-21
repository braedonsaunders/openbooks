/**
 * Missouri income-tax withholding — 2026 percentage formula.
 *
 * Source (fetched from dor.mo.gov, not memory):
 *   2026 Missouri Withholding Tax Formula,
 *     https://dor.mo.gov/forms/Withholding%20Formula_2026.pdf
 *     — Step 1 annual standard deductions; Step 2 annual percentage table
 *       ($1,348 bands, 0% / 2% / 2.5% / 3% / 3.5% / 4% / 4.5% / 4.7%);
 *       official $35,000 married-spouse-works example ($707.81 annual,
 *       $59.00 monthly); missing MO W-4 → single rate;
 *       round each period amount to the nearest whole dollar.
 *   Form 4282, Employer's Tax Guide (Revised 03-2026),
 *     https://dor.mo.gov/forms/4282_2026.pdf
 *     — same formula; no Form MO W-4 → withhold at a single tax rate;
 *       supplemental wages paid separately may use a flat 4.7%.
 *
 * The 2026 formula subtracts the filing-status standard deduction only. It
 * does not subtract federal income tax. This engine does not invent a FIT
 * subtraction the publication no longer prints.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { roundDiv } from "../../../money.ts";
import {
  certificateAmount, certificateChoice, certificateFlag,
} from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/mo.ts";
const DOLLAR = 10_000n;

const MO_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly", "annual", "daily",
];

export type MoFilingStatus =
  | "single"
  | "married_spouse_works"
  | "married_separate"
  | "married_spouse_does_not_work"
  | "head_household";

interface MoBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

export interface MoYearRates {
  year: number;
  status: "published" | "draft";
  singleDeduction: string;
  marriedSpouseWorksDeduction: string;
  marriedSeparateDeduction: string;
  marriedSpouseDoesNotWorkDeduction: string;
  headHouseholdDeduction: string;
  supplementalRate: string;
  brackets: readonly MoBracket[];
}

export const MO_RATES_2026: MoYearRates = {
  year: 2026,
  status: "published",
  singleDeduction: "16100",
  marriedSpouseWorksDeduction: "16100",
  marriedSeparateDeduction: "16100",
  marriedSpouseDoesNotWorkDeduction: "32200",
  headHouseholdDeduction: "24150",
  supplementalRate: pctToRate("4.70"),
  // Annual table. Bases through $9,436 are the formula worksheet's own
  // printed running totals ($0 + $27 + $34 + $40 + $47 + $54 + $61 = $263).
  brackets: [
    { over: "0", notOver: "1348", base: "0", rate: pctToRate("0") },
    { over: "1348", notOver: "2696", base: "0", rate: pctToRate("2.00") },
    { over: "2696", notOver: "4044", base: "27.00", rate: pctToRate("2.50") },
    { over: "4044", notOver: "5392", base: "61.00", rate: pctToRate("3.00") },
    { over: "5392", notOver: "6740", base: "101.00", rate: pctToRate("3.50") },
    { over: "6740", notOver: "8088", base: "148.00", rate: pctToRate("4.00") },
    { over: "8088", notOver: "9436", base: "202.00", rate: pctToRate("4.50") },
    { over: "9436", notOver: null, base: "263.00", rate: pctToRate("4.70") },
  ],
};

const MO_EDITIONS_BY_YEAR: Record<number, MoYearRates> = {
  [MO_RATES_2026.year]: MO_RATES_2026,
};

export const MO_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "2026 Missouri Withholding Tax Formula",
  effectiveFrom: "2026-01-01",
  citation:
    "Missouri Department of Revenue, 2026 Missouri Withholding Tax Formula "
    + "— Step 1 standard deductions, Step 2 annual percentage table, $35,000 "
    + "married-spouse-works example ($707.81 / $59.00)",
  status: "published",
  region: "MO",
}];

export function moRatesForPayDate(payDate: string): MoYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = MO_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(MO_WITHHOLDING, year);
  }
  return rates;
}

export function moRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

export function moStandardDeduction(status: MoFilingStatus, rates: MoYearRates): bigint {
  switch (status) {
    case "married_spouse_does_not_work": return U(rates.marriedSpouseDoesNotWorkDeduction);
    case "head_household": return U(rates.headHouseholdDeduction);
    case "married_spouse_works": return U(rates.marriedSpouseWorksDeduction);
    case "married_separate": return U(rates.marriedSeparateDeduction);
    default: return U(rates.singleDeduction);
  }
}

export function moAnnualTax(taxable: bigint, rates: MoYearRates): bigint {
  if (taxable <= 0n) return 0n;
  let chosen = rates.brackets[0]!;
  for (const bracket of rates.brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = moRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  const period = payPeriodFor(P);
  if (!period || !MO_PERIODS.includes(period) || (period === "daily" && P !== 260)) {
    refuseUnprintedPeriod(MO_WITHHOLDING, P);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("MO_EXEMPT", 1n);
    return { state: "MO", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // No MO W-4: "withhold at a single tax rate."
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as MoFilingStatus;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("MO_ANNUAL_WAGES", annualWages);

  const deduction = moStandardDeduction(status, rates);
  trace("MO_STANDARD_DEDUCTION", deduction);
  const taxable = max0(annualWages - deduction);
  trace("MO_TAXABLE", taxable);

  const annualTax = moAnnualTax(taxable, rates);
  trace("MO_ANNUAL_TAX", annualTax);
  const periodTax = moRoundToDollar(divIntCents(annualTax, P));
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("MO_WITHHELD", total);

  return {
    state: "MO",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const MO_WITHHOLDING: UsStateWithholdingEngine = {
  state: "MO",
  label: "Missouri income tax",
  certificateKey: "us_mo_mow4",
  ratesModule: RATES_MODULE,
  editions: MO_TAX_YEAR_EDITIONS,
  printedPeriods: MO_PERIODS,
  compute,
};
