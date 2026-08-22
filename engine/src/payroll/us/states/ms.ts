/**
 * Mississippi income-tax withholding — Computer Payroll Accounting formula.
 *
 * Source (fetched from dor.ms.gov, not memory):
 *   Pub. 89-700-25-1 (Rev. 07/25), Withholding Income Tax Tables and Employer
 *     Instructions, revised 1.13.2026,
 *     https://www.dor.ms.gov/sites/default/files/tax-forms/business/89700251revised1.13.2026.pdf
 *     — $2,300 / $3,400 / $4,600 / $2,300 standard deductions; 0% of the first
 *       $10,000 of taxable income and 4.0% of the remainder; no 89-350 →
 *       Single, zero exemption; nearest whole dollar.
 *   Computer Payroll Accounting flowchart (Revised 8/13/25) — 2026 periods,
 *     https://www.dor.ms.gov/sites/default/files/business/Computer%20Payroll%20Flowchart%20-%20updated%208-13-25.pdf
 *   Weekly 2026 Table A — official $500–$510 / Single / $0-exemption cell ($11),
 *     https://www.dor.ms.gov/sites/default/files/business/Weekly2026.pdf
 *
 * Automated payroll uses the flowchart. The weekly wage-bracket cell is the
 * official printed wage → withheld golden; it matches the flowchart on that
 * wage. Federal Form W-4 is not a substitute for Form 89-350.
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

const RATES_MODULE = "engine/src/payroll/us/states/ms.ts";
const DOLLAR = 10_000n;

export type MsFilingStatus = "single" | "head_of_family" | "married_one" | "married_both";

const MS_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly", "annual", "daily",
];

export interface MsYearRates {
  year: number;
  status: "published" | "draft";
  rate: string;
  zeroBand: string;
  standardDeduction: Readonly<Record<MsFilingStatus, string>>;
}

export const MS_RATES_2026: MsYearRates = {
  year: 2026,
  status: "published",
  rate: pctToRate("4.0"),
  zeroBand: "10000",
  standardDeduction: {
    single: "2300",
    head_of_family: "3400",
    married_one: "4600",
    married_both: "2300",
  },
};

const MS_EDITIONS_BY_YEAR: Record<number, MsYearRates> = {
  [MS_RATES_2026.year]: MS_RATES_2026,
};

export const MS_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Mississippi Pub. 89-700-25-1 (Rev. 07/25) — 2026 Computer Payroll formula",
  effectiveFrom: "2026-01-01",
  citation:
    "Mississippi Department of Revenue, Pub. 89-700-25-1 (Rev. 07/25) and "
    + "Computer Payroll Accounting flowchart (Rev. 8/13/25) — 4.0% of taxable "
    + "income over $10,000, Weekly 2026 Table A $500–$510 / $0-exemption cell "
    + "($11)",
  status: "published",
  region: "MS",
}];

export function msRatesForPayDate(payDate: string): MsYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = MS_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(MS_WITHHOLDING, year);
  }
  return rates;
}

export function msRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

export function msAnnualTax(taxable: bigint, rates: MsYearRates): bigint {
  const excess = max0(taxable - U(rates.zeroBand));
  if (excess === 0n) return 0n;
  return mulRateCents(excess, rates.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = msRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  const period = payPeriodFor(P);
  if (!period || !MS_PERIODS.includes(period) || (period === "daily" && P !== 260)) {
    refuseUnprintedPeriod(MS_WITHHOLDING, P);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("MS_EXEMPT", 1n);
    return { state: "MS", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // No 89-350: Pub. 89-700 withholds from Tables A at zero exemption — Single,
  // no personal exemption. The flowchart still subtracts the Single standard
  // deduction.
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as MsFilingStatus;
  const exemption = U(certificateAmount(input.certificate, "exemption") ?? "0");
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("MS_ANNUAL_WAGES", annualWages);

  const standardDeduction = U(rates.standardDeduction[status]);
  trace("MS_STANDARD_DEDUCTION", standardDeduction);
  trace("MS_EXEMPTION", exemption);

  const taxable = max0(annualWages - exemption - standardDeduction);
  trace("MS_TAXABLE", taxable);

  const annualTax = msAnnualTax(taxable, rates);
  trace("MS_ANNUAL_TAX", annualTax);
  const periodTax = msRoundToDollar(divIntCents(annualTax, P));
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("MS_WITHHELD", total);

  return {
    state: "MS",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const MS_WITHHOLDING: UsStateWithholdingEngine = {
  state: "MS",
  label: "Mississippi income tax",
  certificateKey: "us_ms_89350",
  ratesModule: RATES_MODULE,
  editions: MS_TAX_YEAR_EDITIONS,
  printedPeriods: MS_PERIODS,
  compute,
};
