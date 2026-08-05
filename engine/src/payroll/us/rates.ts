/**
 * US federal payroll withholding constants, versioned by tax year.
 *
 * Sources (fetched from irs.gov / ssa.gov, not memory):
 *   Pub 15-T (2026): irs.gov/publications/p15t — Annual Percentage Method
 *     Tables for Automated Payroll Systems (STANDARD and Form W-4 Step 2
 *     Checkbox schedules) and the Worksheet 1A constants.
 *   SSA (Oct 2025 announcement): 2026 OASDI wage base $184,500.
 *   FUTA: IRC §3301/§3302 — 6.0% on the first $7,000, up to 5.4% credit.
 *
 * Every printed table row was cross-verified arithmetically: each tentative
 * amount equals the cumulative tax of the prior brackets, and each STANDARD
 * threshold equals the Rev. Proc. 2025-32 bracket boundary shifted by the
 * standard deduction minus the Worksheet 1A adjustment ($12,900 MFJ /
 * $8,600 otherwise).
 */

export type FilingStatus = "single" | "married_joint" | "head_household";

/**
 * One row of an annual percentage-method schedule: adjusted annual wages of
 * at least `atLeast` (and under the next row's `atLeast`) owe `tentative`
 * plus `rate` × the excess over `atLeast`.
 */
export interface WithholdingRow {
  atLeast: string;
  tentative: string;
  rate: string;
}

export interface FicaRates {
  ssRate: string; // 6.2% each side
  ssWageBase: string; // OASDI maximum taxable earnings
  medicareRate: string; // 1.45% each side, no cap
  additionalMedicareRate: string; // employee-only 0.9%
  additionalMedicareThreshold: string; // per-employer YTD wages trigger
}

export interface FutaRates {
  wageBase: string; // first $7,000 (statutory, unchanged since 1983)
  grossRate: string; // 6.0%
  /** Default effective rate after the full 5.4% credit; credit-reduction
   * states are handled by the org-level configurable rate. */
  defaultEffectiveRate: string;
}

export interface SupplementalRates {
  flatRate: string; // optional flat rate on supplemental wages (Pub 15 §7)
  mandatoryHighRate: string; // required over $1,000,000 YTD supplemental
  mandatoryThreshold: string;
}

export interface YearRates {
  year: number;
  standard: Record<FilingStatus, WithholdingRow[]>;
  checkbox: Record<FilingStatus, WithholdingRow[]>;
  /** Worksheet 1A line 1g: subtracted unless the Step 2 box is checked. */
  wageAdjustment: { marriedJoint: string; other: string };
  /** Worksheet 1A line 1k: per-allowance amount for 2019-or-earlier W-4s. */
  allowanceAmount: string;
  fica: FicaRates;
  futa: FutaRates;
  supplemental: SupplementalRates;
}

// 2026 Annual Percentage Method Tables — STANDARD Withholding Rate Schedules.
const STANDARD_2026: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "19300", tentative: "0", rate: "0.10" },
    { atLeast: "44100", tentative: "2480", rate: "0.12" },
    { atLeast: "120100", tentative: "11600", rate: "0.22" },
    { atLeast: "230700", tentative: "35932", rate: "0.24" },
    { atLeast: "422850", tentative: "82048", rate: "0.32" },
    { atLeast: "531750", tentative: "116896", rate: "0.35" },
    { atLeast: "788000", tentative: "206583.50", rate: "0.37" },
  ],
  single: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "7500", tentative: "0", rate: "0.10" },
    { atLeast: "19900", tentative: "1240", rate: "0.12" },
    { atLeast: "57900", tentative: "5800", rate: "0.22" },
    { atLeast: "113200", tentative: "17966", rate: "0.24" },
    { atLeast: "209275", tentative: "41024", rate: "0.32" },
    { atLeast: "263725", tentative: "58448", rate: "0.35" },
    { atLeast: "648100", tentative: "192979.25", rate: "0.37" },
  ],
  head_household: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "15550", tentative: "0", rate: "0.10" },
    { atLeast: "33250", tentative: "1770", rate: "0.12" },
    { atLeast: "83000", tentative: "7740", rate: "0.22" },
    { atLeast: "121250", tentative: "16155", rate: "0.24" },
    { atLeast: "217300", tentative: "39207", rate: "0.32" },
    { atLeast: "271750", tentative: "56631", rate: "0.35" },
    { atLeast: "656150", tentative: "191171", rate: "0.37" },
  ],
};

// 2026 Form W-4, Step 2, Checkbox Withholding Rate Schedules.
const CHECKBOX_2026: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "16100", tentative: "0", rate: "0.10" },
    { atLeast: "28500", tentative: "1240", rate: "0.12" },
    { atLeast: "66500", tentative: "5800", rate: "0.22" },
    { atLeast: "121800", tentative: "17966", rate: "0.24" },
    { atLeast: "217875", tentative: "41024", rate: "0.32" },
    { atLeast: "272325", tentative: "58448", rate: "0.35" },
    { atLeast: "400450", tentative: "103291.75", rate: "0.37" },
  ],
  single: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "8050", tentative: "0", rate: "0.10" },
    { atLeast: "14250", tentative: "620", rate: "0.12" },
    { atLeast: "33250", tentative: "2900", rate: "0.22" },
    { atLeast: "60900", tentative: "8983", rate: "0.24" },
    { atLeast: "108938", tentative: "20512", rate: "0.32" },
    { atLeast: "136163", tentative: "29224", rate: "0.35" },
    { atLeast: "328350", tentative: "96489.63", rate: "0.37" },
  ],
  head_household: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "12075", tentative: "0", rate: "0.10" },
    { atLeast: "20925", tentative: "885", rate: "0.12" },
    { atLeast: "45800", tentative: "3870", rate: "0.22" },
    { atLeast: "64925", tentative: "8077.50", rate: "0.24" },
    { atLeast: "112950", tentative: "19603.50", rate: "0.32" },
    { atLeast: "140175", tentative: "28315.50", rate: "0.35" },
    { atLeast: "332375", tentative: "95585.50", rate: "0.37" },
  ],
};

export const RATES_2026: YearRates = {
  year: 2026,
  standard: STANDARD_2026,
  checkbox: CHECKBOX_2026,
  wageAdjustment: { marriedJoint: "12900", other: "8600" },
  allowanceAmount: "4300",
  fica: {
    ssRate: "0.062",
    ssWageBase: "184500",
    medicareRate: "0.0145",
    additionalMedicareRate: "0.009",
    additionalMedicareThreshold: "200000",
  },
  futa: {
    wageBase: "7000",
    grossRate: "0.06",
    defaultEffectiveRate: "0.006",
  },
  supplemental: {
    flatRate: "0.22",
    mandatoryHighRate: "0.37",
    mandatoryThreshold: "1000000",
  },
};

const BY_YEAR: Record<number, YearRates> = { 2026: RATES_2026 };

export function ratesForPayDate(payDate: string): YearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = BY_YEAR[year];
  if (!rates) {
    throw new Error(`no US federal payroll rates for ${year} — add the Pub 15-T edition`);
  }
  return rates;
}

/** All state/territory postal codes an employee can be employed in. */
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
] as const;
export type UsState = (typeof US_STATES)[number];

/**
 * States with no wage withholding on regular earnings — the coverage of the
 * US pack's first wave. Employees in any other state fail calculation with a
 * clear per-employee error rather than producing silently-wrong stubs.
 */
export const NO_WITHHOLDING_STATES: ReadonlySet<string> = new Set([
  "AK", "FL", "NV", "NH", "SD", "TN", "TX", "WA", "WY",
]);
