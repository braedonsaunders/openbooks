/**
 * Delaware income-tax withholding — Employer's Guide annualized method.
 *
 * Source (fetched from revenue.delaware.gov, not memory):
 *   Employer's Guide (Withholding Regulations and Employer's Duties),
 *     https://revenue.delaware.gov/employers-guide-withholding-regulations-employers-duties/
 *     — Section 15 (no certificate → single, zero allowances; $110 credit);
 *       Section 17 Steps 1–7; Tax Computation Table Effective January 1, 2025;
 *       three official $25,000 worked examples; daily annualization × 300;
 *       supplemental wages paid with regular wages are one payment.
 *
 * The live guide still prints the January 1, 2025 table. 2026 pay dates use
 * that published table; they do not invent a 2026 reprint.
 *
 * Wilmington city wage tax and Form W-4NR nonresident proration are refused
 * rather than invented.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
} from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/de.ts";

export type DeFilingStatus = "single" | "married_joint" | "married_separate";

export interface DeYearRates {
  year: number;
  status: "published" | "draft";
  singleStandardDeduction: string;
  jointStandardDeduction: string;
  exemptionCredit: string;
  /** Section 17 Step 1: "Multiply the daily gross by 300". */
  dailyPeriods: number;
}

export const DE_RATES_2026: DeYearRates = {
  year: 2026,
  status: "published",
  singleStandardDeduction: "3250",
  jointStandardDeduction: "6500",
  exemptionCredit: "110",
  dailyPeriods: 300,
};

const DE_EDITIONS_BY_YEAR: Record<number, DeYearRates> = {
  [DE_RATES_2026.year]: DE_RATES_2026,
};

export const DE_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Delaware Employer's Guide annualized method (2025 table, still published)",
  effectiveFrom: "2026-01-01",
  citation:
    "Delaware Division of Revenue, Employer's Guide, Section 17 — Tax Computation "
    + "Table Effective January 1, 2025; $3,250 / $6,500 standard deduction; $110 "
    + "per exemption; official $25,000 single / joint / separate examples",
  status: "published",
  region: "DE",
}];

export function deRatesForPayDate(payDate: string): DeYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = DE_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(DE_WITHHOLDING, year);
  }
  return rates;
}

/**
 * The publication's own daily factor. Our interface marks daily as 260 or 365;
 * Section 17 Step 1 annualizes daily wages × 300.
 */
export function deAnnualPeriods(periodsPerYear: number, dailyPeriods: number): number {
  if (periodsPerYear === 260 || periodsPerYear === 365) return dailyPeriods;
  return periodsPerYear;
}

export function deStandardDeduction(status: DeFilingStatus, rates: DeYearRates): bigint {
  return status === "married_joint" ? U(rates.jointStandardDeduction) : U(rates.singleStandardDeduction);
}

/** Tax Computation Table Effective January 1, 2025. */
const TABLE: readonly { upTo: string | null; base: string; over: string; rate: string }[] = [
  { upTo: "2000", base: "0", over: "0", rate: pctToRate("0") },
  { upTo: "5000", base: "0", over: "2000", rate: pctToRate("2.20") },
  { upTo: "10000", base: "66", over: "5000", rate: pctToRate("3.90") },
  { upTo: "20000", base: "261", over: "10000", rate: pctToRate("4.80") },
  { upTo: "25000", base: "741", over: "20000", rate: pctToRate("5.20") },
  { upTo: "60000", base: "1001", over: "25000", rate: pctToRate("5.55") },
  { upTo: null, base: "2943.50", over: "60000", rate: pctToRate("6.60") },
];

export function deAnnualTax(taxable: bigint): bigint {
  for (const band of TABLE) {
    if (band.upTo === null || taxable <= U(band.upTo)) {
      return U(band.base) + mulRateCents(max0(taxable - U(band.over)), band.rate);
    }
  }
  throw new Error("Delaware tax computation table is incomplete");
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = deRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Delaware withholding: ${P}`);
  }
  const annualP = deAnnualPeriods(P, rates.dailyPeriods);
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("DE_EXEMPT", 1n);
    return { state: "DE", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const statusRaw = certificateChoice(input.certificate, "filing_status");
  const status: DeFilingStatus =
    statusRaw === "married_joint" || statusRaw === "married_separate" ? statusRaw : "single";
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;

  // Section 13: paid with regular wages, one payment. Separately-paid
  // supplementals need last-period regular tax — not invented here.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(annualP);
  trace("DE_ANNUAL_WAGES", annualWages);

  const deduction = deStandardDeduction(status, rates);
  trace("DE_STANDARD_DEDUCTION", deduction);
  const taxable = max0(annualWages - deduction);
  trace("DE_TAXABLE", taxable);

  const annualTax = deAnnualTax(taxable);
  trace("DE_ANNUAL_TAX", annualTax);

  const credit = U(rates.exemptionCredit) * BigInt(allowances);
  trace("DE_EXEMPTION_CREDIT", credit);
  const afterCredit = max0(annualTax - credit);
  trace("DE_AFTER_CREDIT", afterCredit);

  const periodTax = divIntCents(afterCredit, annualP);
  trace("DE_PERIOD_TAX", periodTax);

  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("DE_WITHHELD", total);

  return {
    state: "DE",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const DE_WITHHOLDING: UsStateWithholdingEngine = {
  state: "DE",
  label: "Delaware income tax",
  certificateKey: "us_de_sdw4a",
  ratesModule: RATES_MODULE,
  editions: DE_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};
