/**
 * Vermont income-tax withholding — 2026 percentage method.
 *
 * Source (fetched from tax.vermont.gov, not memory):
 *   GB-1210, 2026 Income Tax Withholding Instructions, Tables, and Charts,
 *     https://tax.vermont.gov/sites/tax/files/documents/GB-1210-2026.pdf
 *     — percentage-method tables by period and Single / Married;
 *       weekly allowance $103.85; official $1,800 weekly / married /
 *       2-allowance example ($45.77); civil-union partners use Married.
 *
 * This is a per-period TABLE method. An unpublished frequency is refused.
 * Using a federal W-4 in place of W-4VT is certificate administration —
 * the engine does not invent Vermont allowances from a federal form.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
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

const RATES_MODULE = "engine/src/payroll/us/states/vt.ts";

export type VtPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "annual" | "daily";

export type VtFilingStatus = "single" | "married";

const VT_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "annual", "daily",
];

interface VtBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

interface VtPeriodTable {
  allowance: string;
  single: readonly VtBracket[];
  married: readonly VtBracket[];
}

const P335 = pctToRate("3.35");
const P660 = pctToRate("6.60");
const P760 = pctToRate("7.60");
const P875 = pctToRate("8.75");

const VT_TABLES_2026: Record<VtPeriod, VtPeriodTable> = {
  weekly: {
    allowance: "103.85",
    single: [
      { over: "0", notOver: "75", base: "0", rate: pctToRate("0") },
      { over: "75", notOver: "1051", base: "0", rate: P335 },
      { over: "1051", notOver: "2438", base: "32.70", rate: P660 },
      { over: "2438", notOver: "5004", base: "124.24", rate: P760 },
      { over: "5004", notOver: null, base: "319.25", rate: P875 },
    ],
    married: [
      { over: "0", notOver: "226", base: "0", rate: pctToRate("0") },
      { over: "226", notOver: "1855", base: "0", rate: P335 },
      { over: "1855", notOver: "4164", base: "54.57", rate: P660 },
      { over: "4164", notOver: "6227", base: "206.96", rate: P760 },
      { over: "6227", notOver: null, base: "363.75", rate: P875 },
    ],
  },
  biweekly: {
    allowance: "207.69",
    single: [
      { over: "0", notOver: "151", base: "0", rate: pctToRate("0") },
      { over: "151", notOver: "2103", base: "0", rate: P335 },
      { over: "2103", notOver: "4876", base: "65.39", rate: P660 },
      { over: "4876", notOver: "10009", base: "248.41", rate: P760 },
      { over: "10009", notOver: null, base: "638.52", rate: P875 },
    ],
    married: [
      { over: "0", notOver: "453", base: "0", rate: pctToRate("0") },
      { over: "453", notOver: "3711", base: "0", rate: P335 },
      { over: "3711", notOver: "8328", base: "109.14", rate: P660 },
      { over: "8328", notOver: "12455", base: "413.87", rate: P760 },
      { over: "12455", notOver: null, base: "727.52", rate: P875 },
    ],
  },
  semimonthly: {
    allowance: "225.00",
    single: [
      { over: "0", notOver: "164", base: "0", rate: pctToRate("0") },
      { over: "164", notOver: "2278", base: "0", rate: P335 },
      { over: "2278", notOver: "5282", base: "70.82", rate: P660 },
      { over: "5282", notOver: "10843", base: "269.08", rate: P760 },
      { over: "10843", notOver: null, base: "691.72", rate: P875 },
    ],
    married: [
      { over: "0", notOver: "491", base: "0", rate: pctToRate("0") },
      { over: "491", notOver: "4020", base: "0", rate: P335 },
      { over: "4020", notOver: "9022", base: "118.22", rate: P660 },
      { over: "9022", notOver: "13493", base: "448.35", rate: P760 },
      { over: "13493", notOver: null, base: "788.15", rate: P875 },
    ],
  },
  monthly: {
    allowance: "450.00",
    single: [
      { over: "0", notOver: "327", base: "0", rate: pctToRate("0") },
      { over: "327", notOver: "4556", base: "0", rate: P335 },
      { over: "4556", notOver: "10565", base: "141.67", rate: P660 },
      { over: "10565", notOver: "21685", base: "538.27", rate: P760 },
      { over: "21685", notOver: null, base: "1383.39", rate: P875 },
    ],
    married: [
      { over: "0", notOver: "981", base: "0", rate: pctToRate("0") },
      { over: "981", notOver: "8040", base: "0", rate: P335 },
      { over: "8040", notOver: "18044", base: "236.48", rate: P660 },
      { over: "18044", notOver: "26985", base: "896.74", rate: P760 },
      { over: "26985", notOver: null, base: "1576.26", rate: P875 },
    ],
  },
  quarterly: {
    allowance: "1350.00",
    single: [
      { over: "0", notOver: "981", base: "0", rate: pctToRate("0") },
      { over: "981", notOver: "13669", base: "0", rate: P335 },
      { over: "13669", notOver: "31694", base: "425.05", rate: P660 },
      { over: "31694", notOver: "65056", base: "1614.70", rate: P760 },
      { over: "65056", notOver: null, base: "4150.21", rate: P875 },
    ],
    married: [
      { over: "0", notOver: "2944", base: "0", rate: pctToRate("0") },
      { over: "2944", notOver: "24119", base: "0", rate: P335 },
      { over: "24119", notOver: "54131", base: "709.36", rate: P660 },
      { over: "54131", notOver: "80956", base: "2690.15", rate: P760 },
      { over: "80956", notOver: null, base: "4728.85", rate: P875 },
    ],
  },
  annual: {
    allowance: "5400.00",
    single: [
      { over: "0", notOver: "3925", base: "0", rate: pctToRate("0") },
      { over: "3925", notOver: "54675", base: "0", rate: P335 },
      { over: "54675", notOver: "126775", base: "1700.13", rate: P660 },
      { over: "126775", notOver: "260225", base: "6458.73", rate: P760 },
      { over: "260225", notOver: null, base: "16600.93", rate: P875 },
    ],
    married: [
      { over: "0", notOver: "11775", base: "0", rate: pctToRate("0") },
      { over: "11775", notOver: "96475", base: "0", rate: P335 },
      { over: "96475", notOver: "216525", base: "2837.45", rate: P660 },
      { over: "216525", notOver: "323825", base: "10760.75", rate: P760 },
      { over: "323825", notOver: null, base: "18915.55", rate: P875 },
    ],
  },
  daily: {
    allowance: "20.77",
    single: [
      { over: "0", notOver: "15.10", base: "0", rate: pctToRate("0") },
      { over: "15.10", notOver: "210.30", base: "0", rate: P335 },
      { over: "210.30", notOver: "487.60", base: "6.54", rate: P660 },
      { over: "487.60", notOver: "1000.90", base: "24.84", rate: P760 },
      { over: "1000.90", notOver: null, base: "63.85", rate: P875 },
    ],
    married: [
      { over: "0", notOver: "45.30", base: "0", rate: pctToRate("0") },
      { over: "45.30", notOver: "371.10", base: "0", rate: P335 },
      { over: "371.10", notOver: "832.80", base: "10.91", rate: P660 },
      { over: "832.80", notOver: "1245.50", base: "41.39", rate: P760 },
      { over: "1245.50", notOver: null, base: "72.75", rate: P875 },
    ],
  },
};

export interface VtYearRates {
  year: number;
  status: "published" | "draft";
}

export const VT_RATES_2026: VtYearRates = {
  year: 2026,
  status: "published",
};

const VT_EDITIONS_BY_YEAR: Record<number, VtYearRates> = {
  [VT_RATES_2026.year]: VT_RATES_2026,
};

export const VT_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "GB-1210 2026 Income Tax Withholding Instructions, Tables, and Charts",
  effectiveFrom: "2026-01-01",
  citation:
    "Vermont Department of Taxes, GB-1210, 2026 Income Tax Withholding "
    + "Instructions, Tables, and Charts — percentage-method tables, $103.85 "
    + "weekly allowance, $1,800 weekly married 2-allowance example",
  status: "published",
  region: "VT",
}];

export function vtRatesForPayDate(payDate: string): VtYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = VT_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(VT_WITHHOLDING, year);
  }
  return rates;
}

export function vtPeriodTax(taxable: bigint, period: VtPeriod, married: boolean): bigint {
  if (taxable <= 0n) return 0n;
  const brackets = married ? VT_TABLES_2026[period].married : VT_TABLES_2026[period].single;
  let chosen = brackets[0]!;
  for (const bracket of brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  if (chosen.rate === pctToRate("0")) return 0n;
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = vtRatesForPayDate(input.payDate);
  const period = payPeriodFor(input.periodsPerYear);
  if (!period || !VT_PERIODS.includes(period) || (period === "daily" && input.periodsPerYear !== 260)) {
    refuseUnprintedPeriod(VT_WITHHOLDING, input.periodsPerYear);
  }
  const published = period as VtPeriod;
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("VT_EXEMPT", 1n);
    return { state: "VT", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as VtFilingStatus;
  const married = status === "married";
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  trace("VT_WAGES", wages);

  const allowance = U(VT_TABLES_2026[published].allowance) * BigInt(allowances);
  trace("VT_ALLOWANCE", allowance);
  const taxable = max0(wages - allowance);
  trace("VT_TAXABLE", taxable);

  const periodTax = vtPeriodTax(taxable, published, married);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("VT_WITHHELD", total);

  return {
    state: "VT",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const VT_WITHHOLDING: UsStateWithholdingEngine = {
  state: "VT",
  label: "Vermont income tax",
  certificateKey: "us_vt_w4vt",
  ratesModule: RATES_MODULE,
  editions: VT_TAX_YEAR_EDITIONS,
  printedPeriods: VT_PERIODS,
  compute,
};
