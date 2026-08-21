/**
 * Montana income-tax withholding — 2026 per-period formula.
 *
 * Source (fetched from revenue.mt.gov, not memory):
 *   Montana Employer and Information Agent Guide with Montana Withholding
 *     Tax Tables – 2026 (V4 November 2025),
 *     https://revenuefiles.mt.gov/files/Forms/Montana_Employer_and_Information_Agent_Guide_with_Tax_Tables.pdf
 *     — W = A + (B × (G − C)); three MW-4 schedules (line 1a / line 2,
 *       line 1b, line 1c); official examples on each schedule;
 *       missing MW-4 → single (line 1a).
 *   Form MW-4 (2026),
 *     https://revenuefiles.mt.gov/files/Forms/Montana_Employee_Withholding_Allowance_and_Exemption_Certificate_Form_MW-4.pdf
 *     — "If you do not complete your Form MW-4, your employer will withhold
 *       taxes for you using the single filing status on line 1a."
 *
 * This is a per-period TABLE method. An unpublished frequency is refused.
 * The guide's "round up" sentence is followed only where the official
 * examples themselves round up; those examples use nearest-dollar arithmetic
 * (semi-monthly single $33.088 → $33, not $34).
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
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

const RATES_MODULE = "engine/src/payroll/us/states/mt.ts";
const DOLLAR = 10_000n;

export type MtPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly" | "annual" | "daily";

const MT_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly", "annual", "daily",
];

/** MW-4 line 1a / line 2, line 1b, or line 1c. */
export type MtFilingStatus = "single_or_both" | "married_joint" | "head_household";

interface MtBracket {
  atLeast: string;
  lessThan: string | null;
  A: string;
  B: string;
  C: string;
}

type MtSchedule = Record<MtPeriod, readonly MtBracket[]>;

export interface MtYearRates {
  year: number;
  status: "published" | "draft";
  singleOrBoth: MtSchedule;
  marriedJoint: MtSchedule;
  headHousehold: MtSchedule;
}

const R0 = pctToRate("0");
const R47 = pctToRate("4.7");
const R565 = pctToRate("5.65");

export const MT_RATES_2026: MtYearRates = {
  year: 2026,
  status: "published",
  singleOrBoth: {
    monthly: [
      { atLeast: "0", lessThan: "1342", A: "0", B: R0, C: "0" },
      { atLeast: "1342", lessThan: "5300", A: "0", B: R47, C: "1342" },
      { atLeast: "5300", lessThan: null, A: "187", B: R565, C: "5300" },
    ],
    semimonthly: [
      { atLeast: "0", lessThan: "671", A: "0", B: R0, C: "0" },
      { atLeast: "671", lessThan: "2650", A: "0", B: R47, C: "671" },
      { atLeast: "2650", lessThan: null, A: "94", B: R565, C: "2650" },
    ],
    biweekly: [
      { atLeast: "0", lessThan: "619", A: "0", B: R0, C: "0" },
      { atLeast: "619", lessThan: "2446", A: "0", B: R47, C: "619" },
      { atLeast: "2446", lessThan: null, A: "86", B: R565, C: "2446" },
    ],
    weekly: [
      { atLeast: "0", lessThan: "310", A: "0", B: R0, C: "0" },
      { atLeast: "310", lessThan: "1223", A: "0", B: R47, C: "310" },
      { atLeast: "1223", lessThan: null, A: "43", B: R565, C: "1223" },
    ],
    daily: [
      { atLeast: "0", lessThan: "62", A: "0", B: R0, C: "0" },
      { atLeast: "62", lessThan: "245", A: "0", B: R47, C: "62" },
      { atLeast: "245", lessThan: null, A: "9", B: R565, C: "245" },
    ],
    annual: [
      { atLeast: "0", lessThan: "16100", A: "0", B: R0, C: "0" },
      { atLeast: "16100", lessThan: "63600", A: "0", B: R47, C: "16100" },
      { atLeast: "63600", lessThan: null, A: "2233", B: R565, C: "63600" },
    ],
  },
  marriedJoint: {
    monthly: [
      { atLeast: "0", lessThan: "2683", A: "0", B: R0, C: "0" },
      { atLeast: "2683", lessThan: "10600", A: "0", B: R47, C: "2683" },
      { atLeast: "10600", lessThan: null, A: "372", B: R565, C: "10600" },
    ],
    semimonthly: [
      { atLeast: "0", lessThan: "1342", A: "0", B: R0, C: "0" },
      { atLeast: "1342", lessThan: "5300", A: "0", B: R47, C: "1342" },
      { atLeast: "5300", lessThan: null, A: "187", B: R565, C: "5300" },
    ],
    biweekly: [
      { atLeast: "0", lessThan: "1238", A: "0", B: R0, C: "0" },
      { atLeast: "1238", lessThan: "4892", A: "0", B: R47, C: "1238" },
      { atLeast: "4892", lessThan: null, A: "172", B: R565, C: "4892" },
    ],
    weekly: [
      { atLeast: "0", lessThan: "619", A: "0", B: R0, C: "0" },
      { atLeast: "619", lessThan: "2446", A: "0", B: R47, C: "619" },
      { atLeast: "2446", lessThan: null, A: "86", B: R565, C: "2446" },
    ],
    daily: [
      { atLeast: "0", lessThan: "124", A: "0", B: R0, C: "0" },
      { atLeast: "124", lessThan: "489", A: "0", B: R47, C: "124" },
      { atLeast: "489", lessThan: null, A: "18", B: R565, C: "489" },
    ],
    annual: [
      { atLeast: "0", lessThan: "32200", A: "0", B: R0, C: "0" },
      { atLeast: "32200", lessThan: "127200", A: "0", B: R47, C: "32200" },
      { atLeast: "127200", lessThan: null, A: "4465", B: R565, C: "127200" },
    ],
  },
  headHousehold: {
    monthly: [
      { atLeast: "0", lessThan: "2013", A: "0", B: R0, C: "0" },
      { atLeast: "2013", lessThan: "7950", A: "0", B: R47, C: "2013" },
      { atLeast: "7950", lessThan: null, A: "280", B: R565, C: "7950" },
    ],
    semimonthly: [
      { atLeast: "0", lessThan: "1006", A: "0", B: R0, C: "0" },
      { atLeast: "1006", lessThan: "3975", A: "0", B: R47, C: "1006" },
      { atLeast: "3975", lessThan: null, A: "140", B: R565, C: "3975" },
    ],
    biweekly: [
      { atLeast: "0", lessThan: "929", A: "0", B: R0, C: "0" },
      { atLeast: "929", lessThan: "3669", A: "0", B: R47, C: "929" },
      { atLeast: "3669", lessThan: null, A: "129", B: R565, C: "3669" },
    ],
    weekly: [
      { atLeast: "0", lessThan: "464", A: "0", B: R0, C: "0" },
      { atLeast: "464", lessThan: "1835", A: "0", B: R47, C: "464" },
      { atLeast: "1835", lessThan: null, A: "65", B: R565, C: "1835" },
    ],
    daily: [
      { atLeast: "0", lessThan: "93", A: "0", B: R0, C: "0" },
      { atLeast: "93", lessThan: "367", A: "0", B: R47, C: "93" },
      { atLeast: "367", lessThan: null, A: "13", B: R565, C: "367" },
    ],
    annual: [
      { atLeast: "0", lessThan: "24150", A: "0", B: R0, C: "0" },
      { atLeast: "24150", lessThan: "95400", A: "0", B: R47, C: "24150" },
      { atLeast: "95400", lessThan: null, A: "3349", B: R565, C: "95400" },
    ],
  },
};

const MT_EDITIONS_BY_YEAR: Record<number, MtYearRates> = {
  [MT_RATES_2026.year]: MT_RATES_2026,
};

export const MT_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Montana Employer and Information Agent Guide — 2026 withholding formula",
  effectiveFrom: "2026-01-01",
  citation:
    "Montana Department of Revenue, Employer and Information Agent Guide with "
    + "Montana Withholding Tax Tables – 2026 (V4 November 2025) — W = A + "
    + "(B × (G − C)); line 1a / 1b / 1c official examples",
  status: "published",
  region: "MT",
}];

export function mtRatesForPayDate(payDate: string): MtYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = MT_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(MT_WITHHOLDING, year);
  }
  return rates;
}

export function mtRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

function scheduleFor(status: MtFilingStatus, rates: MtYearRates): MtSchedule {
  if (status === "married_joint") return rates.marriedJoint;
  if (status === "head_household") return rates.headHousehold;
  return rates.singleOrBoth;
}

/** W = A + (B × (G − C)), before the nearest-dollar round. */
export function mtPeriodTax(gross: bigint, period: MtPeriod, status: MtFilingStatus, rates: MtYearRates): bigint {
  if (gross <= 0n) return 0n;
  const brackets = scheduleFor(status, rates)[period];
  let chosen = brackets[0]!;
  for (const bracket of brackets) {
    if (gross >= U(bracket.atLeast)) chosen = bracket;
  }
  if (chosen.B === R0) return 0n;
  return U(chosen.A) + mulRateCents(max0(gross - U(chosen.C)), chosen.B);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = mtRatesForPayDate(input.payDate);
  const period = payPeriodFor(input.periodsPerYear);
  if (!period || !MT_PERIODS.includes(period) || (period === "daily" && input.periodsPerYear !== 260)) {
    refuseUnprintedPeriod(MT_WITHHOLDING, input.periodsPerYear);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("MT_EXEMPT", 1n);
    return { state: "MT", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // No MW-4: single filing status on line 1a.
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single_or_both") as MtFilingStatus;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  trace("MT_GROSS", wages);

  const raw = mtPeriodTax(wages, period, status, rates);
  trace("MT_UNROUNDED", raw);
  const periodTax = mtRoundToDollar(raw);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("MT_WITHHELD", total);

  return {
    state: "MT",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const MT_WITHHOLDING: UsStateWithholdingEngine = {
  state: "MT",
  label: "Montana income tax",
  certificateKey: "us_mt_mw4",
  ratesModule: RATES_MODULE,
  editions: MT_TAX_YEAR_EDITIONS,
  printedPeriods: MT_PERIODS,
  compute,
};
