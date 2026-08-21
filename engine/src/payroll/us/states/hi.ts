/**
 * Hawaii income-tax withholding — Booklet A annualized method.
 *
 * Source (fetched from files.hawaii.gov, not memory):
 *   Booklet A, Employer's Tax Guide (Rev. 2025) — the 2026 tables,
 *     https://files.hawaii.gov/tax/news/pubs/25BkltA.pdf
 *     — Appendix Part 1 annualized method; $1,144 regular allowance;
 *       $4,350 extra lump-sum allowance; official $500 weekly / single /
 *       3-allowance example ($9.58); no HW-4 → single, zero allowances;
 *       head of household treated as single; federal W-4 is not a substitute.
 *
 * Hawaii's payroll-update page points employers at this Rev. 2025 booklet
 * for 2026 pay dates. This engine uses that booklet; it does not invent a
 * later reprint.
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

const RATES_MODULE = "engine/src/payroll/us/states/hi.ts";

export type HiFilingStatus = "single" | "married";

interface HiBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

export interface HiYearRates {
  year: number;
  status: "published" | "draft";
  allowance: string;
  lumpSumAllowance: string;
  single: readonly HiBracket[];
  married: readonly HiBracket[];
}

export const HI_RATES_2026: HiYearRates = {
  year: 2026,
  status: "published",
  allowance: "1144",
  lumpSumAllowance: "4350",
  single: [
    { over: "0", notOver: "9600", base: "0", rate: pctToRate("1.40") },
    { over: "9600", notOver: "14400", base: "134.00", rate: pctToRate("3.20") },
    { over: "14400", notOver: "19200", base: "288.00", rate: pctToRate("5.50") },
    { over: "19200", notOver: "24000", base: "552.00", rate: pctToRate("6.40") },
    { over: "24000", notOver: "36000", base: "859.00", rate: pctToRate("6.80") },
    { over: "36000", notOver: "48000", base: "1675.00", rate: pctToRate("7.20") },
    { over: "48000", notOver: "125000", base: "2539.00", rate: pctToRate("7.60") },
    { over: "125000", notOver: null, base: "8391.00", rate: pctToRate("7.90") },
  ],
  married: [
    { over: "0", notOver: "19200", base: "0", rate: pctToRate("1.40") },
    { over: "19200", notOver: "28800", base: "269.00", rate: pctToRate("3.20") },
    { over: "28800", notOver: "38400", base: "576.00", rate: pctToRate("5.50") },
    { over: "38400", notOver: "48000", base: "1104.00", rate: pctToRate("6.40") },
    { over: "48000", notOver: "72000", base: "1718.00", rate: pctToRate("6.80") },
    { over: "72000", notOver: "96000", base: "3350.00", rate: pctToRate("7.20") },
    { over: "96000", notOver: "250000", base: "5078.00", rate: pctToRate("7.60") },
    { over: "250000", notOver: null, base: "16782.00", rate: pctToRate("7.90") },
  ],
};

const HI_EDITIONS_BY_YEAR: Record<number, HiYearRates> = {
  [HI_RATES_2026.year]: HI_RATES_2026,
};

export const HI_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Hawaii Booklet A Employer's Tax Guide (Rev. 2025) — 2026 tables",
  effectiveFrom: "2026-01-01",
  citation:
    "Hawaii Department of Taxation, Booklet A, Employer's Tax Guide (Rev. 2025) "
    + "— Appendix Part 1 annualized method, $1,144 allowance, $4,350 lump-sum "
    + "allowance, $500 weekly 3-allowance example",
  status: "published",
  region: "HI",
}];

export function hiRatesForPayDate(payDate: string): HiYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = HI_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(HI_WITHHOLDING, year);
  }
  return rates;
}

export function hiAnnualTax(taxable: bigint, married: boolean, rates: HiYearRates): bigint {
  if (taxable <= 0n) return 0n;
  const brackets = married ? rates.married : rates.single;
  let chosen = brackets[0]!;
  for (const bracket of brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = hiRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Hawaii withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("HI_EXEMPT", 1n);
    return { state: "HI", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // No HW-4: "withhold tax as if the employee was single and had claimed
  // no withholding allowance." Head of household is treated as single.
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as HiFilingStatus;
  const married = status === "married";
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("HI_ANNUAL_WAGES", annualWages);

  const personal = U(rates.allowance) * BigInt(allowances);
  trace("HI_ALLOWANCES", personal);
  const lumpSum = U(rates.lumpSumAllowance);
  trace("HI_LUMP_SUM", lumpSum);

  const taxable = max0(annualWages - personal - lumpSum);
  trace("HI_TAXABLE", taxable);

  const annualTax = hiAnnualTax(taxable, married, rates);
  trace("HI_ANNUAL_TAX", annualTax);
  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  // Booklet A: "You are not required to withhold tax of less than ten cents
  // from a single wage payment."
  const withheld = total > 0n && total < U("0.10") ? 0n : total;
  trace("HI_WITHHELD", withheld);

  return {
    state: "HI",
    year: rates.year,
    tax: D(withheld),
    taxSupplemental: D(0n),
    factors,
  };
}

export const HI_WITHHOLDING: UsStateWithholdingEngine = {
  state: "HI",
  label: "Hawaii income tax",
  certificateKey: "us_hi_hw4",
  ratesModule: RATES_MODULE,
  editions: HI_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};
