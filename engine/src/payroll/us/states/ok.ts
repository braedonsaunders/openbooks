/**
 * Oklahoma income-tax withholding — 2026 percentage formula.
 *
 * Source (fetched from oklahoma.gov, not memory):
 *   Packet OW-2, 2026 Oklahoma Income Tax Withholding Tables
 *     (Revised 11-2025), effective January 1, 2026,
 *     https://oklahoma.gov/content/dam/ok/en/tax/documents/resources/publications/businesses/withholding-tables/WHTables-2026.pdf
 *     — printed per-period allowance amounts; percentage-method Tables 1–8;
 *       official sample computation ($1,825 semi-monthly, married, two
 *       allowances → $36.67 rounded to $37.00); "Married, but withhold at
 *       higher Single rate" uses the Single table.
 *
 * This is a per-period TABLE method. An unpublished frequency is refused.
 * Percentage-method results are rounded to the nearest whole dollar
 * (drop under 50 cents; 50–99 cents up).
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { roundDiv } from "../../../money.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
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

const RATES_MODULE = "engine/src/payroll/us/states/ok.ts";
const DOLLAR = 10_000n;

export type OkPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "semiannual" | "annual" | "daily";

const OK_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "annual", "daily",
];

export type OkFilingStatus = "single" | "married" | "married_higher_single";

interface OkBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

interface OkPeriodTable {
  allowance: string;
  single: readonly OkBracket[];
  married: readonly OkBracket[];
}

export interface OkYearRates {
  year: number;
  status: "published" | "draft";
  periods: Record<OkPeriod, OkPeriodTable>;
}

const R0 = pctToRate("0");
const R250 = pctToRate("2.50");
const R350 = pctToRate("3.50");
const R450 = pctToRate("4.50");

function bands(
  z: string, a: string, b: string,
  baseB: string, baseC: string,
): readonly OkBracket[] {
  return [
    { over: "0", notOver: z, base: "0", rate: R0 },
    { over: z, notOver: a, base: "0", rate: R250 },
    { over: a, notOver: b, base: baseB, rate: R350 },
    { over: b, notOver: null, base: baseC, rate: R450 },
  ];
}

export const OK_RATES_2026: OkYearRates = {
  year: 2026,
  status: "published",
  periods: {
    weekly: {
      allowance: "19.23",
      single: bands("194", "216", "261", "0.55", "2.10"),
      married: bands("388", "433", "521", "1.11", "4.20"),
    },
    biweekly: {
      allowance: "38.46",
      single: bands("388", "433", "521", "1.11", "4.20"),
      married: bands("777", "865", "1042", "2.21", "8.40"),
    },
    semimonthly: {
      allowance: "41.67",
      single: bands("421", "469", "565", "1.20", "4.55"),
      married: bands("842", "938", "1129", "2.40", "9.10"),
    },
    monthly: {
      allowance: "83.33",
      single: bands("842", "938", "1129", "2.40", "9.10"),
      married: bands("1683", "1875", "2258", "4.79", "18.21"),
    },
    quarterly: {
      allowance: "250.00",
      single: bands("2525", "2813", "3388", "7.19", "27.31"),
      married: bands("5050", "5625", "6775", "14.38", "54.63"),
    },
    semiannual: {
      allowance: "500.00",
      single: bands("5050", "5625", "6775", "14.38", "54.63"),
      married: bands("10100", "11250", "13550", "28.75", "109.25"),
    },
    annual: {
      allowance: "1000.00",
      single: bands("10100", "11250", "13550", "28.75", "109.25"),
      married: bands("20200", "22500", "27100", "57.50", "218.50"),
    },
    daily: {
      allowance: "3.85",
      single: bands("39", "43", "52", "0.11", "0.42"),
      married: bands("78", "87", "104", "0.22", "0.84"),
    },
  },
};

const OK_EDITIONS_BY_YEAR: Record<number, OkYearRates> = {
  [OK_RATES_2026.year]: OK_RATES_2026,
};

export const OK_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Packet OW-2, 2026 Oklahoma Income Tax Withholding Tables",
  effectiveFrom: "2026-01-01",
  citation:
    "Oklahoma Tax Commission, Packet OW-2 (Revised 11-2025) — percentage-method "
    + "Tables 1–8, printed allowance amounts, $1,825 semi-monthly married "
    + "two-allowance sample ($36.67 / $37.00)",
  status: "published",
  region: "OK",
}];

export function okRatesForPayDate(payDate: string): OkYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = OK_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(OK_WITHHOLDING, year);
  }
  return rates;
}

export function okRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

export function okPeriodTax(taxable: bigint, period: OkPeriod, married: boolean, rates: OkYearRates): bigint {
  if (taxable <= 0n) return 0n;
  const table = rates.periods[period];
  const brackets = married ? table.married : table.single;
  let chosen = brackets[0]!;
  for (const bracket of brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  if (chosen.rate === R0) return 0n;
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = okRatesForPayDate(input.payDate);
  const period = payPeriodFor(input.periodsPerYear);
  if (!period || !OK_PERIODS.includes(period) || (period === "daily" && input.periodsPerYear !== 260)) {
    refuseUnprintedPeriod(OK_WITHHOLDING, input.periodsPerYear);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("OK_EXEMPT", 1n);
    return { state: "OK", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as OkFilingStatus;
  const married = status === "married";
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  trace("OK_WAGES", wages);

  const allowance = U(rates.periods[period].allowance) * BigInt(allowances);
  trace("OK_ALLOWANCE", allowance);
  const taxable = max0(wages - allowance);
  trace("OK_TAXABLE", taxable);

  const raw = okPeriodTax(taxable, period, married, rates);
  trace("OK_UNROUNDED", raw);
  const periodTax = okRoundToDollar(raw);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("OK_WITHHELD", total);

  return {
    state: "OK",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const OK_WITHHOLDING: UsStateWithholdingEngine = {
  state: "OK",
  label: "Oklahoma income tax",
  certificateKey: "us_ok_okw4",
  ratesModule: RATES_MODULE,
  editions: OK_TAX_YEAR_EDITIONS,
  printedPeriods: OK_PERIODS,
  compute,
};
