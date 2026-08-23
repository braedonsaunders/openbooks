/**
 * Oregon income tax withholding — Publication 150-206-436 computer formula.
 *
 * Source (fetched from oregon.gov/dor, not memory):
 *   Oregon Withholding Tax Formulas, 150-206-436 (Rev. 12-31-25),
 *     effective January 1, 2026 —
 *     https://www.oregon.gov/dor/forms/FormsPubs/withholding-tax-formulas_206-436_2026.pdf
 *     computer formula, the four worked examples, the phase-out tables, and
 *     the FAQ (pp. of the Rev. 12-31-25 edition).
 *   Form OR-W-4, Oregon Employee’s Withholding Allowance Certificate, and
 *     2026 Form OR-W-4 instructions 150-101-402-1 — the certificate fields
 *     and the no-form fallback order that ends in eight percent.
 *   HB 2119 (2019) as restated in 150-206-436: withhold eight (8) percent of
 *     wages until the employee files a withholding statement or exemption
 *     certificate.
 *
 * The formula, verbatim:
 *
 *   BASE = wages − federal income tax withheld (capped) − standard deduction
 *   WH   = printed addend + [(BASE − printed threshold) × printed rate]
 *          − (exemption credit × allowances)
 *
 * Federal income tax withheld does NOT include FICA (FAQ 1). The cap is
 * $8,750 a year in 2026, then the printed high-income phase-out steps.
 * The personal exemption credit is subtracted AFTER the other calculations
 * (FAQ 12). A negative WH is zero (FAQ 10).
 *
 * Two published methods exist for a period amount. The computer formula
 * works entirely in ANNUAL figures, then divides by the printed period
 * count (12 / 24 / 26 / 52 / 260). Example 1 prints every multiplication
 * as a WHOLE DOLLAR (9,690 × 0.0875 = 848.375 printed as 848). Example 2
 * then divides that annual dollar result and prints a WHOLE DOLLAR per
 * period ($1,789 ÷ 24 = $75). This engine rounds those multiplications
 * and the de-annualized period tax to the nearest dollar — the unit the
 * publication computes in. "The tax for the pay period may be rounded to
 * the nearest dollar, but it's not required" is the percentage-method
 * note; the computer-formula examples are the goldens.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulInt, mulRateCents, rate6, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
  type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import { roundDiv } from "../../../money.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/or.ts";

/** Form OR-W-4 line 1 boxes. Head of household marks Single on the form. */
export type OrMaritalStatus = "single" | "married" | "married_higher_single";

/** Phase-out table the publication keys to the Married box vs every Single treatment. */
export type OrPhaseTable = "single" | "married";

/** Bracket-and-deduction table: Single < 3 allowances, or Single 3+ / Married. */
export type OrBracketTable = "single" | "married_or_3plus";

export interface OrBracket {
  /** Inclusive floor — "At least" in the printed table. */
  atLeast: string;
  /** Inclusive ceiling — "But not over"; null is the open top band. */
  butNotOver: string | null;
  /** Printed addend, dollars. */
  add: string;
  /** Subtracted from BASE before the marginal rate. */
  subtract: string;
  /** Marginal rate, as a decimal fraction via pctToRate. */
  rate: string;
}

export interface OrPhaseStep {
  /** Inclusive annual-wage floor. */
  fromWages: string;
  /** Exclusive annual-wage ceiling; null is the open top. */
  toWages: string | null;
  /** Maximum federal-tax subtraction at this step, dollars. */
  cap: string;
}

export interface OrYearRates {
  year: number;
  status: "published" | "draft";
  /** Personal exemption credit per allowance, annual. */
  exemptionCredit: string;
  /** Single / head of household with fewer than 3 allowances. */
  standardDeductionSingle: string;
  /** Married, or single with 3 or more allowances. */
  standardDeductionMarried: string;
  /**
   * Annual-wage cut at which the "up to $50,000" tables end and the
   * "$50,000 or higher" tables begin. Inclusive of the high tables.
   */
  highWageFrom: string;
  /** Single (and married-higher-single): allowances forced to 0 above this. */
  singleAllowanceCutoff: string;
  /** Married box: allowances forced to 0 above this. */
  marriedAllowanceCutoff: string;
  /** HB 2119 / FAQ 9 — no withholding statement on file. */
  noFormRate: string;
  /** Optional flat rate on separately paid supplemental wages. */
  supplementalRate: string;
  /**
   * Federal-tax subtraction cap at wages below the first printed phase-out
   * step. The 2026 low-wage formula prints this as $8,750; the high-wage
   * tables reprint the same figure as their first step.
   */
  federalCap: string;
  phaseOut: Readonly<Record<OrPhaseTable, readonly OrPhaseStep[]>>;
  /** Low-wage (annual wages up to $50,000) brackets. */
  low: Readonly<Record<OrBracketTable, readonly OrBracket[]>>;
  /** High-wage (annual wages of $50,000 or higher) brackets. */
  high: Readonly<Record<OrBracketTable, readonly OrBracket[]>>;
}

/**
 * 2026 — 150-206-436 (Rev. 12-31-25), effective January 1, 2026.
 *
 * Percents and dollar constants are the publication's own digits. Percents
 * go through pctToRate so a reviewer compares "4.75" to the printed 4.75%.
 */
export const OR_RATES_2026: OrYearRates = {
  year: 2026,
  status: "published",
  exemptionCredit: "263",
  standardDeductionSingle: "2910",
  standardDeductionMarried: "5820",
  highWageFrom: "50000",
  singleAllowanceCutoff: "100000",
  marriedAllowanceCutoff: "200000",
  noFormRate: pctToRate("8"),
  supplementalRate: pctToRate("8"),
  federalCap: "8750",
  phaseOut: {
    // [S] PHASE OUT, plus the low-wage formula's "$8,750" cap for wages
    // below the first printed high-wage step.
    single: [
      { fromWages: "0", toWages: "125000", cap: "8750" },
      { fromWages: "125000", toWages: "130000", cap: "7000" },
      { fromWages: "130000", toWages: "135000", cap: "5250" },
      { fromWages: "135000", toWages: "140000", cap: "3500" },
      { fromWages: "140000", toWages: "145000", cap: "1750" },
      { fromWages: "145000", toWages: null, cap: "0" },
    ],
    // [M] PHASE OUT. FAQ 7: only the Married box uses these steps.
    married: [
      { fromWages: "0", toWages: "250000", cap: "8750" },
      { fromWages: "250000", toWages: "260000", cap: "7000" },
      { fromWages: "260000", toWages: "270000", cap: "5250" },
      { fromWages: "270000", toWages: "280000", cap: "3500" },
      { fromWages: "280000", toWages: "290000", cap: "1750" },
      { fromWages: "290000", toWages: null, cap: "0" },
    ],
  },
  low: {
    single: [
      { atLeast: "0", butNotOver: "4550", add: "263", subtract: "0", rate: pctToRate("4.75") },
      { atLeast: "4550", butNotOver: "11400", add: "479", subtract: "4550", rate: pctToRate("6.75") },
      { atLeast: "11400", butNotOver: "50000", add: "941", subtract: "11400", rate: pctToRate("8.75") },
    ],
    married_or_3plus: [
      { atLeast: "0", butNotOver: "9100", add: "263", subtract: "0", rate: pctToRate("4.75") },
      { atLeast: "9100", butNotOver: "22800", add: "695", subtract: "9100", rate: pctToRate("6.75") },
      { atLeast: "22800", butNotOver: "50000", add: "1620", subtract: "22800", rate: pctToRate("8.75") },
    ],
  },
  high: {
    // Printed first band starts at $38,340 — the minimum BASE at $50,000
    // wages with the $8,750 cap and the $2,910 single standard deduction.
    // The open top is "125,000" with no "but not over".
    single: [
      { atLeast: "0", butNotOver: "125000", add: "678", subtract: "11400", rate: pctToRate("8.75") },
      { atLeast: "125000", butNotOver: null, add: "10618", subtract: "125000", rate: pctToRate("9.9") },
    ],
    married_or_3plus: [
      { atLeast: "0", butNotOver: "250000", add: "1357", subtract: "22800", rate: pctToRate("8.75") },
      { atLeast: "250000", butNotOver: null, add: "21237", subtract: "250000", rate: pctToRate("9.9") },
    ],
  },
};

const OR_EDITIONS_BY_YEAR: Record<number, OrYearRates> = {
  [OR_RATES_2026.year]: OR_RATES_2026,
};

export const OR_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "150-206-436 (Rev. 12-31-25)",
  effectiveFrom: "2026-01-01",
  citation:
    "Oregon Department of Revenue, Oregon Withholding Tax Formulas, 150-206-436 "
    + "(Rev. 12-31-25), effective January 1, 2026 — computer formula, Examples 1–4, "
    + "and FAQ; Form OR-W-4; 2026 OR-W-4 instructions 150-101-402-1",
  status: "published",
  region: "OR",
}];

export function orRatesForPayDate(payDate: string): OrYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = OR_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(OR_WITHHOLDING, year);
  }
  return rates;
}

const DOLLAR = 10_000n;
const RATE6 = 1_000_000n;

/** Nearest whole dollar — the unit Example 1 line 7 and Example 2 compute in. */
export function orRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

/** amount × rate, rounded half-up to the dollar. */
export function orMulRateDollars(units: bigint, rate: string): bigint {
  return roundDiv(units * rate6(rate), RATE6 * DOLLAR) * DOLLAR;
}

/**
 * OR-W-4 line 1 onto the two formula tables.
 *
 * "Married, but withhold at the higher single rate" uses the Single
 * phase-out (FAQ 4) and the Single allowance cutoff (Example 4). Head of
 * household marks Single on the form and is not a third table.
 */
export function orPhaseTableFor(status: OrMaritalStatus): OrPhaseTable {
  return status === "married" ? "married" : "single";
}

export function orBracketTableFor(
  status: OrMaritalStatus,
  allowances: number,
): OrBracketTable {
  return status === "married" || allowances >= 3 ? "married_or_3plus" : "single";
}

/**
 * Allowances after the printed income cutoffs.
 *
 * Single / married-higher-single: "If single and wages are greater than
 * $100,000 then allowances = 0." Married box: greater than $200,000.
 */
export function orAllowancesUsed(
  status: OrMaritalStatus,
  claimed: number,
  annualWages: bigint,
  rates: OrYearRates,
): number {
  const n = claimed < 0 ? 0 : claimed;
  if (status === "married") {
    return annualWages > U(rates.marriedAllowanceCutoff) ? 0 : n;
  }
  return annualWages > U(rates.singleAllowanceCutoff) ? 0 : n;
}

/** Federal-tax subtraction cap for these annual wages and this phase-out table. */
export function orFederalCap(
  annualWages: bigint,
  phase: OrPhaseTable,
  rates: OrYearRates,
): bigint {
  for (const step of rates.phaseOut[phase]) {
    const from = U(step.fromWages);
    const to = step.toWages === null ? null : U(step.toWages);
    if (annualWages >= from && (to === null || annualWages < to)) {
      return U(step.cap);
    }
  }
  return U(rates.federalCap);
}

function bracketFor(base: bigint, bands: readonly OrBracket[]): OrBracket {
  for (const band of bands) {
    const floor = U(band.atLeast);
    const cap = band.butNotOver === null ? null : U(band.butNotOver);
    if (base >= floor && (cap === null || base <= cap)) return band;
  }
  return bands[bands.length - 1]!;
}

export interface OrAnnualInput {
  annualWages: bigint;
  annualFederalWithheld: bigint;
  status: OrMaritalStatus;
  claimedAllowances: number;
  rates: OrYearRates;
}

export interface OrAnnualResult {
  tax: bigint;
  factors: Record<string, string>;
}

/**
 * The annual computer formula — 150-206-436 Examples 1, 3 and 4.
 *
 * Period amounts are the caller's problem: `compute` annualizes, then
 * de-annualizes with Example 2's printed divisors.
 */
export function orAnnualWithholding(input: OrAnnualInput): OrAnnualResult {
  const { rates } = input;
  const factors: Record<string, string> = { OR_METHOD: "formula" };
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const allowances = orAllowancesUsed(
    input.status, input.claimedAllowances, input.annualWages, rates,
  );
  const phase = orPhaseTableFor(input.status);
  const brackets = orBracketTableFor(input.status, allowances);
  const high = input.annualWages >= U(rates.highWageFrom);
  factors.OR_STATUS = input.status;
  factors.OR_PHASE = phase;
  factors.OR_BRACKETS = brackets;
  factors.OR_TABLE = high ? "high" : "low";
  factors.OR_ALLOWANCES = String(allowances);

  const std = U(
    brackets === "married_or_3plus"
      ? rates.standardDeductionMarried
      : rates.standardDeductionSingle,
  );
  const cap = orFederalCap(input.annualWages, phase, rates);
  const federal = input.annualFederalWithheld < 0n
    ? 0n
    : input.annualFederalWithheld < cap ? input.annualFederalWithheld : cap;
  trace("OR_ANNUAL_WAGES", input.annualWages);
  trace("OR_FEDERAL_WITHHELD", input.annualFederalWithheld);
  trace("OR_FEDERAL_CAP", cap);
  trace("OR_FEDERAL_USED", federal);
  trace("OR_STANDARD_DEDUCTION", std);

  const base = max0(input.annualWages - federal - std);
  trace("OR_BASE", base);

  const band = bracketFor(base, (high ? rates.high : rates.low)[brackets]);
  const excess = orMulRateDollars(max0(base - U(band.subtract)), band.rate);
  const fromRates = U(band.add) + excess;
  const credit = U(rates.exemptionCredit) * BigInt(allowances);
  const tax = max0(fromRates - credit);
  trace("OR_FROM_RATES", fromRates);
  trace("OR_CREDIT", credit);
  trace("OR_ANNUAL_TAX", tax);
  factors.OR_BAND_ADD = band.add;
  factors.OR_BAND_RATE = band.rate;

  return { tax, factors };
}

/**
 * 150-206-436 "Alternative withholding method for supplemental wage payments"
 * — optional 8% on a supplemental paid at a different time than regular pay.
 * Exported rather than applied: `compute` aggregates (FAQ 5: bonuses are
 * wages), which is always permitted.
 */
export function orSupplementalFlat(payDate: string, supplemental: string): string {
  const rates = orRatesForPayDate(payDate);
  return D(mulRateCents(U(supplemental), rates.supplementalRate));
}

/**
 * TriMet / Lane Transit District payroll tax, when the employer has entered
 * a rate.
 *
 * 150-206-436 publishes neither a rate nor an employee-withholding rule for
 * these districts (they are employer-assessed taxes on Form OQ). A rate is
 * never invented from another publication. Missing → refuse by name.
 */
export function orTransitWithholding(input: {
  wages: string;
  rate: string | null | undefined;
  district: string;
}): string {
  if (input.rate == null || input.rate === "") {
    throw new Error(
      `no transit payroll-tax rate has been entered for ${input.district} (Oregon). `
      + "Publication 150-206-436 (Rev. 12-31-25) does not publish TriMet or Lane "
      + "Transit District rates or an employee-withholding computation for them, "
      + "so the rate is employer-entered. Inventing 0.8237% or 0.80% from Form OQ "
      + "would silently withhold the wrong money the day either district moved.",
    );
  }
  return D(mulRateCents(max0(U(input.wages)), input.rate));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = orRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Oregon withholding: ${P}`);
  }

  const wages = U(input.wages) + U(input.supplemental ?? "0");

  // HB 2119 / OR-W-4 instructions: no withholding statement on file → 8%.
  // emptyResolvedCertificate and resolveCertificate-with-no-row both report
  // onFile === false. Reading fields off an empty certificate would throw.
  if (!input.certificate.onFile) {
    const tax = mulRateCents(wages, rates.noFormRate);
    return {
      state: "OR",
      year: rates.year,
      tax: D(tax),
      taxSupplemental: D(0n),
      factors: { OR_METHOD: "eight_percent", OR_RATE: rates.noFormRate, OR_WAGES: D(wages) },
    };
  }

  if (certificateFlag(input.certificate, "exempt")) {
    return {
      state: "OR",
      year: rates.year,
      tax: D(0n),
      taxSupplemental: D(0n),
      factors: { OR_METHOD: "exempt", OR_EXEMPT: "1" },
    };
  }

  const status = (certificateChoice(input.certificate, "marital_status")
    ?? "single") as OrMaritalStatus;
  const claimed = certificateCount(input.certificate, "allowances") ?? 0;

  // Publication 150-206-436: BASE subtracts federal income tax withheld.
  // That figure is this period's FIT, supplied on the certificate because
  // UsStateWithholdingInput has no federal-tax field. Missing is a refusal
  // — substituting $0 would over-withhold every Oregon employee who had
  // federal tax taken out.
  const periodFederal = certificateAmount(input.certificate, "federal_income_tax_withheld");
  if (periodFederal == null) {
    throw new Error(
      "Oregon withholding (150-206-436) requires this period's federal income tax "
      + "withheld as an input to BASE (FAQ 1: not FICA; FAQ 11: yes, the program "
      + "must subtract it, up to the printed cap). The engine will not assume $0.",
    );
  }

  const { tax: annualTax, factors } = orAnnualWithholding({
    annualWages: mulInt(wages, P),
    annualFederalWithheld: mulInt(U(periodFederal), P),
    status,
    claimedAllowances: claimed,
    rates,
  });

  // Example 2: divide the annual dollar result by the printed period count
  // and keep a whole dollar. Extra (OR-W-4 line 3) is added AFTERWARDS.
  const periodTax = orRoundToDollar(divIntCents(annualTax, P));
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  factors.OR_PERIOD_TAX = D(periodTax);
  factors.OR_WITHHELD = D(total);

  return {
    state: "OR",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const OR_WITHHOLDING: UsStateWithholdingEngine = {
  state: "OR",
  label: "Oregon income tax",
  certificateKey: "us_or_orw4",
  ratesModule: RATES_MODULE,
  editions: OR_TAX_YEAR_EDITIONS,
  // The computer formula annualizes, then divides by P. FAQ 8 names 24 vs
  // 26; daily is 260. Any positive P computes — a scaled wage-bracket table
  // is not what this publication is.
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Oregon withholding declarations — Form OR-W-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's declaration. Shape matches
 * IL_W4 / NC_NC4 / NC_REGION.
 *
 * Sources: Form OR-W-4; 2026 OR-W-4 instructions 150-101-402-1;
 * Publication 150-206-436 (Rev. 12-31-25).
 */
/** Form OR-W-4 — Oregon Employee’s Withholding Allowance Certificate. */
export const OR_CERTIFICATE: PayrollCertificate = {
  key: "us_or_orw4",
  form: "OR-W-4",
  label: "Oregon Employee’s Withholding Allowance Certificate",
  scope: { level: "region", region: "OR" },
  purpose: "withholding",
  citation:
    "Oregon Form OR-W-4; 2026 Form OR-W-4 instructions 150-101-402-1; "
    + "Oregon Withholding Tax Formulas, 150-206-436 (Rev. 12-31-25)",
  summary:
    "Sets Oregon marital status, allowances, and extra withholding. If no OR-W-4 "
    + "(and no pre-2020 Oregon-only or federal W-4) is on file, HB 2119 requires "
    + "the employer to withhold eight percent of wages until the employee files.",
  storage: "certificate_rows",
  fields: [
    {
      key: "marital_status",
      label: "Line 1 — Marital status",
      kind: "choice",
      choices: [
        {
          value: "single",
          label: "Single",
          help:
            "OR-W-4: mark Single if you plan to file single, married filing separately, "
            + "or head of household. Uses the Single standard deduction, brackets, and "
            + "phase-out unless three or more allowances are claimed.",
        },
        {
          value: "married",
          label: "Married",
          help:
            "Married filing jointly or qualifying surviving spouse. Uses the Married "
            + "standard deduction, brackets, and the [M] phase-out. FAQ 7: only this "
            + "box uses the married phase-out amounts.",
        },
        {
          value: "married_higher_single",
          label: "Married, but withhold at the higher single rate",
          help:
            "FAQ 4 and Example 4: use the Single phase-out and the Single $100,000 "
            + "allowance cutoff, not the Married ones.",
        },
      ],
      default: "single",
      required: true,
      help:
        "Form OR-W-4 line 1. Head of household marks Single — the form has no third "
        + "filing-status box. Default Single is the form's own unread box, not a guess.",
    },
    {
      key: "allowances",
      label: "Line 2 — Oregon allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "From the OR-W-4 worksheets. Each allowance is a $263 annual credit in 2026, "
        + "subtracted AFTER the rate (FAQ 12). Single wages over $100,000, or Married "
        + "wages over $200,000, force this to zero — the publication's own cutoff.",
    },
    {
      key: "additional_per_period",
      label: "Line 3 — Additional Oregon withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A flat dollar amount added AFTER the computer formula. It is not multiplied "
        + "by a rate and it is not an allowance.",
    },
    {
      key: "exempt",
      label: "Line 4 — Exempt from Oregon withholding",
      kind: "flag",
      help:
        "Line 4a exemption code plus the word Exempt on line 4b. For wages the "
        + "election expires February 15 of the following year; a new OR-W-4 is due "
        + "each year. Without a current exemption the employer withholds. This engine "
        + "honors the flag on file — dating the February 15 cutoff is certificate "
        + "administration, not a silent fallback.",
    },
    {
      key: "federal_income_tax_withheld",
      label: "Federal income tax withheld this period (formula input)",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Not an OR-W-4 line. Publication 150-206-436 builds BASE from wages minus "
        + "federal income tax withheld minus the standard deduction (FAQ 1: do not "
        + "include FICA; FAQ 11: the program must subtract it, up to the printed "
        + "annual cap). The payroll run supplies THIS PERIOD's federal income tax; "
        + "the engine annualizes it. A missing amount is refused — assuming zero "
        + "would over-withhold.",
    },
  ],
};

export const OR_REGION: PayrollRegionWithholding = {
  region: "OR",
  label: "Oregon income tax",
  implemented: true,
  // 150-206-436 assumes Oregon-source wages. OR-W-4 instructions address
  // part-year and nonresident filers. Nonresident wages earned in Oregon
  // are withheld under the same computer formula.
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by 150-206-436: whether an Oregon resident's wages
  // earned entirely outside Oregon must be withheld on (and whether any
  // other-state credit reduces that withholding). Other DOR pages discuss
  // out-of-state employers; the formulas publication does not. Declared
  // unknown rather than guessed.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_or_orw4",
  subRegions: [
    {
      code: "TRIMET",
      label: "TriMet transit payroll tax",
      kind: "transit_district",
      reaches: ["resident", "nonresident"],
      rateSource: { kind: "tenant", rateKey: "us_or_trimet" },
      implemented: true,
      citation:
        "Publication 150-206-436 (Rev. 12-31-25) does not publish a TriMet rate or "
        + "employee-withholding rule. The district exists; the rate is employer-entered. "
        + "orTransitWithholding refuses without that rate and never invents 0.8237%.",
    },
    {
      code: "LTD",
      label: "Lane Transit District payroll tax",
      kind: "transit_district",
      reaches: ["resident", "nonresident"],
      rateSource: { kind: "tenant", rateKey: "us_or_ltd" },
      implemented: true,
      citation:
        "Publication 150-206-436 (Rev. 12-31-25) does not publish an LTD rate or "
        + "employee-withholding rule. The district exists; the rate is employer-entered. "
        + "orTransitWithholding refuses without that rate and never invents 0.80%.",
    },
    {
      code: "STT",
      label: "Oregon statewide transit tax",
      kind: "statewide_transit",
      reaches: ["resident", "nonresident"],
      rateSource: { kind: "pack" },
      implemented: false,
      citation:
        "Publication 150-206-436 (Rev. 12-31-25) does not publish the statewide "
        + "transit tax or a withholding computation for it. Declared so the gap is "
        + "named; the 0.1% figure on Form OQ is not transcribed here.",
    },
  ],
  subRegionConflictRule: "both",
  citation:
    "Oregon Department of Revenue, Oregon Withholding Tax Formulas, 150-206-436 "
    + "(Rev. 12-31-25), effective January 1, 2026; Form OR-W-4; 2026 OR-W-4 "
    + "instructions 150-101-402-1",
};
