/**
 * Utah income tax withholding — Publication 14 computer formula (Schedules 1–8).
 *
 * Sources (fetched from tax.utah.gov, not memory):
 *   Publication 14, Withholding Tax Guide (Rev. 4/26), effective June 1, 2026 —
 *     https://files.tax.utah.gov/tax/forms/pubs/pub-14.pdf
 *     https://tax.utah.gov/forms-pubs/pub-14/
 *     the computer-formula schedules (pp. 8–10) and the six worked examples
 *     (p. 11). Rate 4.45%. Tables apply to pay periods beginning on or after
 *     June 1, 2026.
 *   Publication 14, Withholding Tax Guide (Rev. 4/25), effective June 1, 2025 —
 *     https://files.tax.utah.gov/tax/forms/2025/pub-14.pdf
 *     still the governing edition for 2026 pay dates before June 1. Rate 4.5%.
 *     Same schedule shape; different base allowances, thresholds, and examples.
 *
 * The formula, verbatim from every schedule:
 *
 *   1. Utah taxable wages
 *   2. Multiply line 1 by the printed rate
 *   3. Base allowance (printed)
 *   4. Line 1 minus the printed threshold (not less than 0)
 *   5. Multiply line 4 by .013 (1.3%)
 *   6. Line 3 minus line 5 (not less than 0)
 *   7. Withholding tax = line 2 minus line 6 (not less than 0)
 *
 * Pub 14 prints every intermediate of its six worked examples as a WHOLE
 * DOLLAR. 9000 × .0445 = 400.50 is printed as 401; 400 × .0445 = 17.80 is
 * printed as 18. This engine rounds lines 2 and 5 to the nearest dollar, which
 * is the unit the publication computes in. Rounding only the final line would
 * miss those examples.
 *
 * "Use the Single column for taxpayers who file as head-of-household on their
 * federal return." (Utah Withholding Tables footnote, p. 12.)
 *
 * Utah publishes no state W-4. Filing status is the federal W-4 status, and
 * there is no subtraction for federal allowances: "No subtraction is made for
 * personal or other withholding allowances claimed on federal form W-4."
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, rate6, U } from "../../canada/decimal.ts";
import { certificateChoice, certificateFlag } from "../../certificates.ts";
import { roundDiv } from "../../../money.ts";
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

const RATES_MODULE = "engine/src/payroll/us/states/ut.ts";

/** Pub 14 prints a schedule for each of these eight periods. */
type UtPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "semiannual" | "annual" | "daily";

const UT_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "annual", "daily",
];

export type UtSchedule = "single" | "married";

interface UtScheduleValues {
  /** Line 3 — the printed base allowance, dollars. */
  baseAllowance: string;
  /** Line 4 — subtract this from wages (not less than 0). */
  threshold: string;
}

export interface UtEdition {
  /** Selected by PAY DATE. */
  effectiveFrom: string;
  /** Exclusive; null while current. */
  effectiveTo: string | null;
  year: number;
  label: string;
  citation: string;
  /** Line 2 rate, as the publication prints the percent. */
  printedRatePercent: string;
  rate: string;
  /** Line 5 phase-out rate, as the publication prints the percent. */
  printedPhaseoutPercent: string;
  phaseoutRate: string;
  schedules: Readonly<Record<UtPeriod, Readonly<Record<UtSchedule, UtScheduleValues>>>>;
}

/**
 * Publication 14 (Rev. 4/25), effective June 1, 2025 — still in force for
 * 2026 pay dates before June 1, 2026.
 */
export const UT_EDITION_2025: UtEdition = {
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-06-01",
  year: 2026,
  label: "Publication 14 (Rev. 4/25), effective June 1, 2025",
  citation:
    "Utah State Tax Commission, Publication 14, Withholding Tax Guide (Rev. 4/25), "
    + "effective June 1, 2025 — computer-formula Schedules 1–8 (pp. 8–10) and worked "
    + "examples (p. 11); https://files.tax.utah.gov/tax/forms/2025/pub-14.pdf",
  printedRatePercent: "4.5",
  rate: pctToRate("4.5"),
  printedPhaseoutPercent: "1.3",
  phaseoutRate: pctToRate("1.3"),
  schedules: {
    weekly: {
      single: { baseAllowance: "9", threshold: "175" },
      married: { baseAllowance: "17", threshold: "350" },
    },
    biweekly: {
      single: { baseAllowance: "17", threshold: "350" },
      married: { baseAllowance: "35", threshold: "701" },
    },
    semimonthly: {
      single: { baseAllowance: "19", threshold: "379" },
      married: { baseAllowance: "38", threshold: "759" },
    },
    monthly: {
      single: { baseAllowance: "38", threshold: "759" },
      married: { baseAllowance: "75", threshold: "1518" },
    },
    quarterly: {
      single: { baseAllowance: "113", threshold: "2277" },
      married: { baseAllowance: "225", threshold: "4553" },
    },
    semiannual: {
      single: { baseAllowance: "225", threshold: "4554" },
      married: { baseAllowance: "450", threshold: "9107" },
    },
    annual: {
      single: { baseAllowance: "450", threshold: "9107" },
      married: { baseAllowance: "900", threshold: "18213" },
    },
    daily: {
      single: { baseAllowance: "2", threshold: "35" },
      married: { baseAllowance: "3", threshold: "70" },
    },
  },
};

/**
 * Publication 14 (Rev. 4/26), effective June 1, 2026 — 4.45% after S.B. 60.
 */
export const UT_EDITION_2026: UtEdition = {
  effectiveFrom: "2026-06-01",
  effectiveTo: null,
  year: 2026,
  label: "Publication 14 (Rev. 4/26), effective June 1, 2026",
  citation:
    "Utah State Tax Commission, Publication 14, Withholding Tax Guide (Rev. 4/26), "
    + "effective June 1, 2026 — computer-formula Schedules 1–8 (pp. 8–10) and worked "
    + "examples (p. 11); https://files.tax.utah.gov/tax/forms/pubs/pub-14.pdf",
  printedRatePercent: "4.45",
  rate: pctToRate("4.45"),
  printedPhaseoutPercent: "1.3",
  phaseoutRate: pctToRate("1.3"),
  schedules: {
    weekly: {
      single: { baseAllowance: "9", threshold: "180" },
      married: { baseAllowance: "19", threshold: "360" },
    },
    biweekly: {
      single: { baseAllowance: "19", threshold: "360" },
      married: { baseAllowance: "37", threshold: "719" },
    },
    semimonthly: {
      single: { baseAllowance: "20", threshold: "390" },
      married: { baseAllowance: "40", threshold: "779" },
    },
    monthly: {
      single: { baseAllowance: "40", threshold: "779" },
      married: { baseAllowance: "81", threshold: "1558" },
    },
    quarterly: {
      single: { baseAllowance: "121", threshold: "2337" },
      married: { baseAllowance: "243", threshold: "4674" },
    },
    semiannual: {
      single: { baseAllowance: "243", threshold: "4674" },
      married: { baseAllowance: "485", threshold: "9348" },
    },
    annual: {
      single: { baseAllowance: "485", threshold: "9348" },
      married: { baseAllowance: "970", threshold: "18696" },
    },
    daily: {
      single: { baseAllowance: "2", threshold: "36" },
      married: { baseAllowance: "4", threshold: "72" },
    },
  },
};

export const UT_EDITIONS: readonly UtEdition[] = [UT_EDITION_2025, UT_EDITION_2026];

const UT_LOADED_YEARS = new Set([2026]);

export const UT_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Publication 14 (Rev. 4/25 through May 31; Rev. 4/26 from June 1)",
  effectiveFrom: "2026-01-01",
  citation: UT_EDITIONS.map((edition) => edition.citation).join("; "),
  status: "published",
  region: "UT",
}];

const DOLLAR = 10_000n;
const RATE6 = 1_000_000n;

/** "Round off" each printed multiplication to the nearest whole dollar. */
export function utRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

/** amount × rate, rounded half-up to the dollar — the unit Pub 14 prints. */
export function utMulRateDollars(units: bigint, rate: string): bigint {
  return roundDiv(units * rate6(rate), RATE6 * DOLLAR) * DOLLAR;
}

export function utEditionForPayDate(payDate: string): UtEdition {
  const year = Number(payDate.slice(0, 4));
  if (!UT_LOADED_YEARS.has(year)) refuseUntranscribedYear(UT_WITHHOLDING, year);
  const edition = UT_EDITIONS.find((candidate) =>
    payDate >= candidate.effectiveFrom
    && (candidate.effectiveTo == null || payDate < candidate.effectiveTo));
  if (!edition) {
    throw new Error(
      `no Utah withholding edition is loaded for a pay date of ${payDate} — ${RATES_MODULE}`,
    );
  }
  return edition;
}

function utPeriodFor(periodsPerYear: number): UtPeriod {
  const period = payPeriodFor(periodsPerYear);
  if (period == null || !UT_PERIODS.includes(period)) {
    refuseUnprintedPeriod(UT_WITHHOLDING, periodsPerYear);
  }
  return period as UtPeriod;
}

/**
 * Pub 14's two columns from the federal W-4 filing status.
 *
 * Head of household takes the Single column — the withholding-tables footnote,
 * not an inference. Married filing separately is the W-4's "Single or married
 * filing separately" box, which is Single. Default single is the federal W-4
 * default when no certificate is on file.
 */
export function utScheduleFor(filingStatus: string | null): UtSchedule {
  return filingStatus === "married" ? "married" : "single";
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const edition = utEditionForPayDate(input.payDate);
  const period = utPeriodFor(input.periodsPerYear);
  const factors: Record<string, string> = {
    UT_EDITION: edition.effectiveFrom,
    UT_RATE: edition.rate,
  };

  // Pub 14: write "Utah Only - Exempt, Interstate Transportation" or
  // "Utah Only - Exempt, Military Spouse" under W-4 box 4c.
  if (certificateFlag(input.certificate, "exempt")) {
    factors.UT_EXEMPT = "1";
    return {
      state: "UT", year: edition.year, tax: D(0n), taxSupplemental: D(0n), factors,
    };
  }

  const schedule = utScheduleFor(certificateChoice(input.certificate, "filing_status"));
  const values = edition.schedules[period][schedule];
  factors.UT_SCHEDULE = schedule;
  factors.UT_PERIOD = period;

  // Pub 14: "Utah calculates withholding tax based on wages subject to federal
  // withholding tax." Supplemental wages are ordinary compensation here — the
  // publication prints no separate supplemental rate.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  factors.UT_WAGES = D(wages);

  // Line 2.
  const line2 = utMulRateDollars(wages, edition.rate);
  factors.UT_LINE2 = D(line2);

  // Line 3.
  const base = U(values.baseAllowance);
  factors.UT_BASE_ALLOWANCE = D(base);

  // Line 4.
  const line4 = max0(wages - U(values.threshold));
  factors.UT_LINE4 = D(line4);
  factors.UT_THRESHOLD = values.threshold;

  // Line 5.
  const line5 = utMulRateDollars(line4, edition.phaseoutRate);
  factors.UT_LINE5 = D(line5);

  // Line 6.
  const line6 = max0(base - line5);
  factors.UT_LINE6 = D(line6);

  // Line 7.
  const tax = max0(line2 - line6);
  factors.UT_TAX = D(tax);

  return {
    state: "UT",
    year: edition.year,
    tax: D(tax),
    taxSupplemental: D(0n),
    factors,
  };
}

export const UT_WITHHOLDING: UsStateWithholdingEngine = {
  state: "UT",
  label: "Utah income tax",
  certificateKey: "us_ut_w4",
  ratesModule: RATES_MODULE,
  editions: UT_TAX_YEAR_EDITIONS,
  // Each schedule is a printed set of period-specific constants. A frequency
  // Pub 14 does not print is refused rather than scaled — the weekly $180
  // threshold times 13/52 is not the quarterly $2,337.
  printedPeriods: UT_PERIODS,
  compute,
};
