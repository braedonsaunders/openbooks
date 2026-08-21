/**
 * Maryland income-tax withholding — 2026 Employer Withholding Guide,
 * percentage method (state PLUS local).
 *
 * Source (fetched from marylandcomptroller.gov, not memory):
 *   2026 Maryland Employer Withholding Guide, Revised December 2025,
 *     https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/instructions/withholding/2026/withholding-guide.pdf
 *     — standard deduction $3,400 for the percentage method; $3,200 per
 *       MW507 exemption; the four percentage-chart steps (p. 6); the
 *       combined state+local percentage tables; the $5,000-a-year
 *       "do not withhold" floor; lump-sum annual-bonus rule (p. 9);
 *       reciprocity on Form MW507 (p. 5); Maryland residents working
 *       outside Maryland (p. 4).
 *   Withholding Tax Facts, January 2026 – December 2026,
 *     COM/RAD-098 Revised 12/25,
 *     https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/legal-publications/facts/withholding-tax-facts-2026.pdf
 *     — the 23-county + Baltimore City actual 2026 local rates, and the
 *       instruction to use the printed table that equals or is closest
 *       to (without going below) the actual local rate.
 *   Form MW507, Employee's Maryland Withholding Exemption Certificate
 *     (COM/RAD-036 07/25),
 *     https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/forms/2026/mw507.pdf
 *     — filing-status block, line 1 exemptions (default ONE if no
 *       certificate is furnished), line 2 additional, lines 3–8 exempt
 *       claims, county of residence.
 *
 * Maryland law "does not permit the use of a rate of less than 4.75% to
 * be used for withholding tax purposes." The printed combined tables
 * therefore start at (4.75% + local), not at the 2% / 3% / 4% statutory
 * bands used on the annual return.
 *
 * The percentage-method tables are combined state + local. Local tax
 * "is based on taxable income and not on Maryland state tax." For a
 * computerized method the engine annualizes, subtracts the Guide's
 * $3,400 + ($3,200 × exemptions), applies the annual combined table,
 * and divides by the pay periods. That reproduces every printed annual
 * plus-amount exactly. Period wage-bracket plus-amounts in the weekly
 * tables are the same annual figures ÷ P, rounded by the typesetter;
 * a few higher weekly plus-amounts differ from annual÷52 by a cent
 * and are not used as compute goldens.
 *
 * Anne Arundel and Frederick publish graduated local rates, not a
 * single table rate. Those two are applied as the Guide/Tax Facts
 * print them (Anne Arundel marginal on taxable net income; Frederick
 * a flat rate for the band the annual taxable falls in), plus the
 * same state withholding schedule.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulInt, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCode, certificateCount, certificateFlag,
} from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/md.ts";

export type MdSchedule = "single" | "joint";

export type MdPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "annual" | "daily";

/** One state-withholding band. Rates below 4.75% are not used. */
export interface MdStateBand {
  /** Null on the top band. Inclusive — "but not over". */
  upTo: string | null;
  over: string;
  /** Publication percent of the STATE withholding rate (not combined). */
  statePercent: string;
}

export interface MdPeriodConstants {
  /** Printed "Amount of one exemption" for the payroll period. */
  exemption: string;
  /** Printed "Standard Deduction" for the payroll period. */
  standardDeduction: string;
  /** "DO NOT WITHHOLD ON GROSS WAGES LESS THAN" this period amount. */
  minimumGross: string;
}

export interface MdCounty {
  code: string;
  /** Two-letter Central Payroll Bureau stub code, when the memo prints one. */
  alpha: string;
  name: string;
  /**
   * The actual 2026 local rate Tax Facts prints, or `"graduated"` when the
   * county publishes income-banded local rates instead of one rate.
   */
  rate: string | "graduated";
  /**
   * The percentage-method TABLE the Guide/Tax Facts tell a table-using
   * employer to pick — the printed table that equals or is closest to,
   * without going below, the actual rate. Null for graduated counties
   * (there is no single table).
   */
  tablePercent: string | null;
}

export interface MdYearRates {
  year: number;
  status: "published" | "draft";
  /** Guide: "the Standard Deduction is $3,400." */
  standardDeduction: string;
  /** Tax Facts / MW507: treat each exemption as $3,200. */
  exemption: string;
  /** Guide: withholding is not required below this annual rate of pay. */
  annualMinimum: string;
  /** Highest state withholding rate — lump-sum annual bonus (Guide p. 9). */
  lumpSumStatePercent: string;
  state: Readonly<Record<MdSchedule, readonly MdStateBand[]>>;
  periods: Readonly<Record<MdPeriod, MdPeriodConstants>>;
}

/**
 * Add two percents the publication prints (e.g. 4.75 + 3.20 → 7.95)
 * as an exact decimal-point shift on the digit strings. No float.
 */
export function addPrintedPercents(a: string, b: string): string {
  const decA = a.includes(".") ? a.split(".")[1]!.length : 0;
  const decB = b.includes(".") ? b.split(".")[1]!.length : 0;
  const dec = Math.max(decA, decB);
  const toInt = (printed: string) => {
    const [whole = "0", fraction = ""] = printed.split(".");
    return BigInt(whole + fraction.padEnd(dec, "0"));
  };
  const sum = toInt(a) + toInt(b);
  const digits = sum.toString().padStart(dec + 1, "0");
  if (dec === 0) return digits;
  const whole = digits.slice(0, digits.length - dec).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(digits.length - dec).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

/**
 * 2026 — Employer Withholding Guide, Revised December 2025.
 *
 * State withholding bands are the Tax Facts / Guide statutory brackets
 * from 4.75% up (the 2% / 3% / 4% bands are not used for withholding).
 */
export const MD_RATES_2026: MdYearRates = {
  year: 2026,
  status: "published",
  standardDeduction: "3400",
  exemption: "3200",
  annualMinimum: "5000",
  lumpSumStatePercent: "6.50",
  state: {
    // (b) Single including Married Filing Separately or Dependent
    single: [
      { over: "0", upTo: "100000", statePercent: "4.75" },
      { over: "100000", upTo: "125000", statePercent: "5.00" },
      { over: "125000", upTo: "150000", statePercent: "5.25" },
      { over: "150000", upTo: "250000", statePercent: "5.50" },
      { over: "250000", upTo: "500000", statePercent: "5.75" },
      { over: "500000", upTo: "1000000", statePercent: "6.25" },
      { over: "1000000", upTo: null, statePercent: "6.50" },
    ],
    // (a) Married Filing Joint or Head of Household
    joint: [
      { over: "0", upTo: "150000", statePercent: "4.75" },
      { over: "150000", upTo: "175000", statePercent: "5.00" },
      { over: "175000", upTo: "225000", statePercent: "5.25" },
      { over: "225000", upTo: "300000", statePercent: "5.50" },
      { over: "300000", upTo: "600000", statePercent: "5.75" },
      { over: "600000", upTo: "1200000", statePercent: "6.25" },
      { over: "1200000", upTo: null, statePercent: "6.50" },
    ],
  },
  // Guide formula box, printed on every percentage-method page.
  // First column = one exemption ($3,200 ÷ P); second = standard deduction
  // ($3,400 ÷ P). The footnote: "The standard Deduction is $3,400."
  periods: {
    weekly: { exemption: "61.54", standardDeduction: "65.38", minimumGross: "96.00" },
    biweekly: { exemption: "123.08", standardDeduction: "130.76", minimumGross: "192.00" },
    semimonthly: { exemption: "133.33", standardDeduction: "141.66", minimumGross: "208.00" },
    monthly: { exemption: "266.67", standardDeduction: "283.33", minimumGross: "417.00" },
    quarterly: { exemption: "800.00", standardDeduction: "850.00", minimumGross: "1250.00" },
    annual: { exemption: "3200.00", standardDeduction: "3400.00", minimumGross: "5000.00" },
    daily: { exemption: "8.77", standardDeduction: "9.31", minimumGross: "13.70" },
  },
};

/**
 * 23 counties + Baltimore City, Tax Facts January 2026 – December 2026
 * (COM/RAD-098 Revised 12/25). Two-digit codes from the Comptroller
 * Central Payroll Bureau 2026 local-rate attachment (01–24).
 *
 * Table percents follow Tax Facts: "use the table that agrees with, or
 * is closest to, without going below the actual local tax rate."
 */
export const MD_COUNTIES_2026: readonly MdCounty[] = [
  { code: "01", alpha: "AL", name: "Allegany", rate: "3.20", tablePercent: "3.20" },
  { code: "02", alpha: "AA", name: "Anne Arundel", rate: "graduated", tablePercent: null },
  { code: "03", alpha: "BA", name: "Baltimore County", rate: "3.20", tablePercent: "3.20" },
  { code: "04", alpha: "BC", name: "Baltimore City", rate: "3.20", tablePercent: "3.20" },
  { code: "05", alpha: "CV", name: "Calvert", rate: "3.20", tablePercent: "3.20" },
  { code: "06", alpha: "CL", name: "Caroline", rate: "3.20", tablePercent: "3.20" },
  { code: "07", alpha: "CR", name: "Carroll", rate: "3.03", tablePercent: "3.05" },
  { code: "08", alpha: "CE", name: "Cecil", rate: "2.74", tablePercent: "2.75" },
  { code: "09", alpha: "CH", name: "Charles", rate: "3.03", tablePercent: "3.05" },
  { code: "10", alpha: "DR", name: "Dorchester", rate: "3.30", tablePercent: "3.30" },
  { code: "11", alpha: "FR", name: "Frederick", rate: "graduated", tablePercent: null },
  { code: "12", alpha: "GR", name: "Garrett", rate: "2.65", tablePercent: "2.65" },
  { code: "13", alpha: "HF", name: "Harford", rate: "3.06", tablePercent: "3.10" },
  { code: "14", alpha: "HW", name: "Howard", rate: "3.20", tablePercent: "3.20" },
  { code: "15", alpha: "KT", name: "Kent", rate: "3.30", tablePercent: "3.30" },
  { code: "16", alpha: "MG", name: "Montgomery", rate: "3.20", tablePercent: "3.20" },
  { code: "17", alpha: "PG", name: "Prince George's", rate: "3.20", tablePercent: "3.20" },
  { code: "18", alpha: "QA", name: "Queen Anne's", rate: "3.20", tablePercent: "3.20" },
  { code: "19", alpha: "SM", name: "St. Mary's", rate: "3.20", tablePercent: "3.20" },
  { code: "20", alpha: "SO", name: "Somerset", rate: "3.20", tablePercent: "3.20" },
  { code: "21", alpha: "TA", name: "Talbot", rate: "2.40", tablePercent: "2.40" },
  { code: "22", alpha: "WA", name: "Washington", rate: "2.95", tablePercent: "3.00" },
  { code: "23", alpha: "WI", name: "Wicomico", rate: "3.20", tablePercent: "3.20" },
  { code: "24", alpha: "WO", name: "Worcester", rate: "2.25", tablePercent: "2.25" },
];

const MD_COUNTY_BY_CODE = new Map<string, MdCounty>();
for (const county of MD_COUNTIES_2026) {
  MD_COUNTY_BY_CODE.set(county.code, county);
  MD_COUNTY_BY_CODE.set(county.alpha, county);
  MD_COUNTY_BY_CODE.set(county.alpha.toLowerCase(), county);
  MD_COUNTY_BY_CODE.set(county.name.toLowerCase(), county);
}

const MD_EDITIONS_BY_YEAR: Record<number, MdYearRates> = {
  [MD_RATES_2026.year]: MD_RATES_2026,
};

export const MD_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Maryland Employer Withholding Guide (Revised December 2025)",
  effectiveFrom: "2026-01-01",
  citation:
    "Comptroller of Maryland, 2026 Maryland Employer Withholding Guide, Revised December "
    + "2025 — percentage method (p. 6), $3,400 standard deduction, $3,200 exemption, "
    + "combined state+local tables; Withholding Tax Facts January 2026–December 2026 "
    + "(COM/RAD-098 Revised 12/25) county local rates; Form MW507 (COM/RAD-036 07/25)",
  status: "published",
  region: "MD",
}];

export function mdRatesForPayDate(payDate: string): MdYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = MD_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(MD_WITHHOLDING, year);
  }
  return rates;
}

/**
 * Form MW507's three filing-status checkboxes onto the Guide's two schedules.
 *
 * "The SINGLE rate is used by single employees; employees who are dependents
 * on another person's tax return, or employees who are Married planning to
 * file separately. The JOINT rate is used by Married taxpayers who plan to
 * file joint returns, employees who qualify for Head of Household status …
 * or … Widow or Widower with a dependent child."
 *
 * MW507's middle box is labelled "Married (surviving spouse or unmarried
 * Head of Household) Rate" — that is schedule (a). "Married, but withhold
 * at Single rate" is schedule (b), as the checkbox says.
 *
 * No certificate: the Guide withholds as if one exemption was claimed and
 * does not name a filing status. The certificate default is Single — the
 * form's first box, not a guess at joint.
 */
export function mdScheduleFor(filingStatus: string | null): MdSchedule {
  return filingStatus === "married_joint_hoh" ? "joint" : "single";
}

export function mdCounty(code: string): MdCounty {
  const trimmed = code.trim();
  const padded = /^\d{1,2}$/.test(trimmed) ? trimmed.padStart(2, "0") : trimmed;
  const county = MD_COUNTY_BY_CODE.get(padded)
    ?? MD_COUNTY_BY_CODE.get(padded.toUpperCase())
    ?? MD_COUNTY_BY_CODE.get(padded.toLowerCase());
  if (!county) {
    throw new Error(
      `"${code}" is not a Maryland county published in Withholding Tax Facts `
      + `January 2026–December 2026 (${RATES_MODULE}). The Comptroller lists `
      + "23 counties and Baltimore City (codes 01–24). An unknown code is not "
      + "a zero rate and is not the 3.30% maximum.",
    );
  }
  return county;
}

/**
 * Combined withholding rate the percentage-method table prints:
 * state withholding percent + the table's local percent.
 */
export function mdCombinedRate(statePercent: string, localPercent: string): string {
  return pctToRate(addPrintedPercents(statePercent, localPercent));
}

/**
 * Annual combined tax from the Guide's annual percentage-method table
 * (flat local table rate added to each state withholding band).
 */
export function mdAnnualCombinedTax(input: {
  taxable: bigint;
  schedule: MdSchedule;
  localPercent: string;
  rates?: MdYearRates;
}): { tax: bigint; bandOver: string; combinedRate: string } {
  const rates = input.rates ?? MD_RATES_2026;
  if (input.taxable <= 0n) {
    return { tax: 0n, bandOver: "0", combinedRate: mdCombinedRate("4.75", input.localPercent) };
  }
  const bands = rates.state[input.schedule];
  let taxAtFloor = 0n;
  for (const band of bands) {
    const combined = mdCombinedRate(band.statePercent, input.localPercent);
    const ceiling = band.upTo == null ? null : U(band.upTo);
    if (ceiling == null || input.taxable <= ceiling) {
      const excess = max0(input.taxable - U(band.over));
      return { tax: taxAtFloor + mulRateCents(excess, combined), bandOver: band.over, combinedRate: combined };
    }
    taxAtFloor = taxAtFloor + mulRateCents(U(band.upTo!) - U(band.over), combined);
  }
  throw new Error(`no Maryland withholding band covers taxable wages of ${D(input.taxable)}`);
}

/**
 * Anne Arundel local tax — Guide p. 9 / Tax Facts 2026.
 *
 * Printed as ".0270 of Maryland taxable net income of $1 through $50,000"
 * (and the next two slices). Marginal, on annual taxable net income.
 */
export function mdAnneArundelLocal(taxable: bigint, schedule: MdSchedule): bigint {
  if (taxable <= 0n) return 0n;
  const bands = schedule === "joint"
    ? [
      { over: "0", upTo: "75000", percent: "2.70" },
      { over: "75000", upTo: "480000", percent: "2.94" },
      { over: "480000", upTo: null, percent: "3.20" },
    ]
    : [
      { over: "0", upTo: "50000", percent: "2.70" },
      { over: "50000", upTo: "400000", percent: "2.94" },
      { over: "400000", upTo: null, percent: "3.20" },
    ];
  let tax = 0n;
  let remaining = taxable;
  for (const band of bands) {
    const width = band.upTo == null
      ? remaining
      : bmin(remaining, U(band.upTo) - U(band.over));
    if (width <= 0n) continue;
    tax += mulRateCents(width, pctToRate(band.percent));
    remaining -= width;
    if (remaining <= 0n) break;
  }
  return tax;
}

/**
 * Frederick local tax — Guide p. 9 / Tax Facts 2026.
 *
 * Printed as ".0225 for taxpayers who have a taxable net income of at
 * least $1 and not exceeding $25,000" (then three higher bands). A flat
 * rate on the whole taxable, selected by which band the annual taxable
 * falls in — the Guide's "for taxpayers who have" wording, not a slice.
 */
export function mdFrederickLocal(taxable: bigint, schedule: MdSchedule): bigint {
  if (taxable <= 0n) return 0n;
  const bands = schedule === "joint"
    ? [
      { upTo: "25000", percent: "2.25" },
      { upTo: "100000", percent: "2.75" },
      { upTo: "250000", percent: "2.96" },
      { upTo: null, percent: "3.20" },
    ]
    : [
      { upTo: "25000", percent: "2.25" },
      { upTo: "50000", percent: "2.75" },
      { upTo: "150000", percent: "2.96" },
      { upTo: null, percent: "3.20" },
    ];
  for (const band of bands) {
    if (band.upTo == null || taxable <= U(band.upTo)) {
      return mulRateCents(taxable, pctToRate(band.percent));
    }
  }
  throw new Error(`no Frederick local band covers taxable wages of ${D(taxable)}`);
}

function bmin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** State withholding only — the 4.75%+ schedule, no local. */
export function mdAnnualStateTax(taxable: bigint, schedule: MdSchedule, rates = MD_RATES_2026): bigint {
  return mdAnnualCombinedTax({ taxable, schedule, localPercent: "0", rates }).tax;
}

/**
 * Guide p. 9 lump-sum annual bonus: highest state rate (6.50%) plus the
 * highest local rate for the county of residence. Exported, not applied
 * by `compute` — the Guide names this for a lump-sum annual bonus, not
 * for every supplemental paid with regular wages. Regular bonuses,
 * commissions and vacation pay are ordinary "taxable wages" (p. 5).
 *
 * Highest local for a flat county is that county's actual rate. For
 * Anne Arundel and Frederick the published top slice is 3.20%. For a
 * nonresident the Guide prints no lump-sum local; the special
 * nonresident rate of 2.25% is the only published nonresident local.
 */
export function mdLumpSumBonus(input: {
  payDate: string;
  amount: string;
  county?: MdCounty | null;
  basis: "resident" | "nonresident";
}): string {
  const rates = mdRatesForPayDate(input.payDate);
  const localPercent = input.basis === "nonresident"
    ? "2.25"
    : input.county == null
      ? null
      : input.county.rate === "graduated" ? "3.20" : input.county.rate;
  if (localPercent == null) {
    throw new Error(
      "Maryland lump-sum bonus withholding needs the employee's county of residence "
      + "(Guide p. 9: highest state rate plus the highest local rate for the county "
      + "of residence). A missing county is not a zero local rate.",
    );
  }
  const combined = mdCombinedRate(rates.lumpSumStatePercent, localPercent);
  return D(mulRateCents(max0(U(input.amount)), combined));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = mdRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Maryland withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (
    certificateFlag(input.certificate, "exempt")
    || certificateFlag(input.certificate, "military_spouse_exempt")
    || certificateFlag(input.certificate, "reciprocal_exempt")
  ) {
    trace("MD_EXEMPT", 1n);
    return { state: "MD", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // MW507 lines 6–7: a Pennsylvania resident also exempt from the LOCAL tax.
  // Line 5 alone (state-only) is handled below after taxable is known.
  if (
    certificateFlag(input.certificate, "pa_york_adams_local_exempt")
    || certificateFlag(input.certificate, "pa_other_local_exempt")
  ) {
    trace("MD_PA_LOCAL_EXEMPT", 1n);
    return { state: "MD", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const schedule = mdScheduleFor(certificateChoice(input.certificate, "filing_status"));
  factors.MD_SCHEDULE = schedule;
  // Guide p. 5: no MW507 → withhold as if the employee claimed ONE exemption.
  const exemptions = certificateCount(input.certificate, "exemptions") ?? 1;

  // p. 5: bonuses, commissions, vacation pay are ordinary taxable wages.
  // The p. 9 lump-sum rule is a separate election (`mdLumpSumBonus`).
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = mulInt(wages, P);
  trace("MD_ANNUAL_WAGES", annualWages);

  const periodName = periodNameFor(P);
  if (periodName && wages < U(rates.periods[periodName].minimumGross)) {
    factors.MD_BELOW_MINIMUM = "1";
    const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
    return {
      state: "MD", year: rates.year, tax: D(extra), taxSupplemental: D(0n),
      factors: { ...factors, MD_WITHHELD: D(extra) },
    };
  }
  if (!periodName && annualWages < U(rates.annualMinimum)) {
    factors.MD_BELOW_MINIMUM = "1";
    const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
    return {
      state: "MD", year: rates.year, tax: D(extra), taxSupplemental: D(0n),
      factors: { ...factors, MD_WITHHELD: D(extra) },
    };
  }

  const annualExemption = U(rates.standardDeduction) + U(rates.exemption) * BigInt(Math.max(exemptions, 0));
  trace("MD_ANNUAL_EXEMPTION", annualExemption);
  const taxable = max0(annualWages - annualExemption);
  trace("MD_TAXABLE", taxable);

  const paStateOnly = certificateFlag(input.certificate, "pa_state_exempt");
  let annualTax: bigint;
  if (paStateOnly) {
    // MW507 line 5: exempt from the STATE portion; still liable for local
    // at the Maryland county of employment. Local "is based on taxable
    // income and not on Maryland state tax." Checked before the generic
    // nonresident 2.25% table — a Pennsylvania domiciliary is a
    // nonresident of Maryland, but the form withholds work-county local,
    // not the special 2.25% rate.
    const county = requireCounty(input.certificate, "Pennsylvania line-5 local withholding");
    factors.MD_COUNTY = county.code;
    annualTax = localOnly(taxable, schedule, county);
    factors.MD_PA_STATE_EXEMPT = "1";
  } else if (input.basis === "nonresident") {
    // Guide p. 6: "use the Nonresident rate, which includes no local tax;
    // but does include the Special 2.25% Nonresident rate."
    factors.MD_LOCAL_TABLE = "2.25";
    const result = mdAnnualCombinedTax({ taxable, schedule, localPercent: "2.25", rates });
    annualTax = result.tax;
    factors.MD_BAND_OVER = result.bandOver;
    factors.MD_COMBINED_RATE = result.combinedRate;
  } else {
    const county = requireCounty(input.certificate, "Maryland resident withholding");
    factors.MD_COUNTY = county.code;
    if (county.rate === "graduated") {
      const state = mdAnnualStateTax(taxable, schedule, rates);
      const local = county.code === "02"
        ? mdAnneArundelLocal(taxable, schedule)
        : mdFrederickLocal(taxable, schedule);
      trace("MD_STATE_TAX", state);
      trace("MD_LOCAL_TAX", local);
      annualTax = state + local;
      factors.MD_LOCAL_TABLE = county.name;
    } else {
      const localPercent = county.tablePercent!;
      factors.MD_LOCAL_TABLE = localPercent;
      const result = mdAnnualCombinedTax({ taxable, schedule, localPercent, rates });
      annualTax = result.tax;
      factors.MD_BAND_OVER = result.bandOver;
      factors.MD_COMBINED_RATE = result.combinedRate;
    }
  }
  trace("MD_ANNUAL_TAX", annualTax);

  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("MD_WITHHELD", total);

  return {
    state: "MD",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

function localOnly(taxable: bigint, schedule: MdSchedule, county: MdCounty): bigint {
  if (county.rate === "graduated") {
    return county.code === "02"
      ? mdAnneArundelLocal(taxable, schedule)
      : mdFrederickLocal(taxable, schedule);
  }
  return mulRateCents(taxable, pctToRate(county.rate));
}

function requireCounty(
  certificate: UsStateWithholdingInput["certificate"],
  why: string,
): MdCounty {
  const raw = certificateCode(certificate, "residence_county");
  if (raw == null || raw.trim() === "" || /^n\/?a$/i.test(raw.trim())) {
    throw new Error(
      `Maryland ${why} needs the MW507 county of residence (nonresidents enter the `
      + "Maryland county of employment). The Employer Withholding Guide does not "
      + "name a default local rate when the county is blank — Tax Facts lists a "
      + "rate for each county, and an omitted county is not 3.30%.",
    );
  }
  return mdCounty(raw);
}

function periodNameFor(periodsPerYear: number): MdPeriod | null {
  switch (periodsPerYear) {
    case 52: return "weekly";
    case 26: return "biweekly";
    case 24: return "semimonthly";
    case 12: return "monthly";
    case 4: return "quarterly";
    case 1: return "annual";
    case 365: return "daily";
    default: return null;
  }
}

export const MD_WITHHOLDING: UsStateWithholdingEngine = {
  state: "MD",
  label: "Maryland income tax",
  certificateKey: "us_md_mw507",
  ratesModule: RATES_MODULE,
  editions: MD_TAX_YEAR_EDITIONS,
  // The computerized method annualizes the Guide's $3,400 / $3,200 figures,
  // so any frequency computes. The printed period constants are the same
  // annual figures ÷ P (transcribed in `MD_RATES_2026.periods` for the
  // conformance test). Daily constants are 365-day; a 260-day daily
  // payroll still annualizes rather than borrowing the 365-day box.
  printedPeriods: null,
  compute,
};
