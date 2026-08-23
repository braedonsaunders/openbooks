/**
 * Minnesota income tax withholding — the Computer Formula.
 *
 * Source (fetched from revenue.state.mn.us, not memory):
 *   2026 Minnesota Withholding Tax Instructions and Tables
 *     (https://www.revenue.state.mn.us/sites/default/files/2025-12/wh-inst-26.pdf),
 *     Computer Formula p. 34; Form W-4MN default and reciprocity p. 4;
 *     supplemental-wage rule p. 7. Effective January 1, 2026 — "This formula
 *     supersedes any formulas before Jan. 1, 2026."
 *   Form W-4MN, Minnesota Employee Withholding Certificate (Rev. 4/26).
 *   Form MWR, Reciprocity Exemption/Affidavit of Residency for Tax Year 2026
 *     (https://www.revenue.state.mn.us/sites/default/files/2025-12/mwr.pdf).
 *
 * The formula annualizes, subtracts $5,300 per W-4MN allowance, looks the
 * remainder up in the Single or Married Step-5 chart, and de-annualizes.
 * Daily pay multiplies by 360 — the booklet's own list, not 260 or 365.
 *
 * Step 6: "You may round the amount to the nearest dollar." The wage-bracket
 * tables on pp. 16–33 ARE rounded to the dollar; the computer formula does
 * not require it. This engine keeps the cent, which is what the formula
 * produces before the optional round.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
  type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/mn.ts";

export type MnSchedule = "single" | "married";

export interface MnBracket {
  /** Exclusive floor — "More than" in the Step-5 chart. */
  moreThan: string;
  /** Inclusive ceiling; null is the open top band. */
  butNotMoreThan: string | null;
  /** Subtracted from the Step-4 result before the rate is applied. */
  subtract: string;
  rate: string;
  add: string;
}

export interface MnYearRates {
  year: number;
  status: "published" | "draft";
  /** Step 3 — one W-4MN allowance, annual. */
  allowance: string;
  /**
   * The booklet's listed daily multiplier. Other frequencies use the caller's
   * periods-per-year; this is transcribed because it is the only place the
   * booklet states that a day is 360 periods, not 260 or 365.
   */
  dailyPeriods: number;
  supplementalRate: string;
  schedules: Readonly<Record<MnSchedule, readonly MnBracket[]>>;
}

/**
 * 2026 — Computer Formula p. 34.
 *
 * The first extracted table (floors $4,700 / $38,010 / $114,130 / $207,850)
 * is Single; the second ($14,700 / $63,400 / $208,180 / $352,630) is Married.
 * Amounts at or below the first floor withhold nothing — "More than" is
 * exclusive, and Step 4 already stops at zero.
 */
export const MN_RATES_2026: MnYearRates = {
  year: 2026,
  status: "published",
  allowance: "5300",
  dailyPeriods: 360,
  supplementalRate: pctToRate("6.25"),
  schedules: {
    single: [
      { moreThan: "4700", butNotMoreThan: "38010", subtract: "4700", rate: pctToRate("5.35"), add: "0" },
      { moreThan: "38010", butNotMoreThan: "114130", subtract: "38010", rate: pctToRate("6.80"), add: "1782.09" },
      { moreThan: "114130", butNotMoreThan: "207850", subtract: "114130", rate: pctToRate("7.85"), add: "6958.25" },
      { moreThan: "207850", butNotMoreThan: null, subtract: "207850", rate: pctToRate("9.85"), add: "14315.27" },
    ],
    married: [
      { moreThan: "14700", butNotMoreThan: "63400", subtract: "14700", rate: pctToRate("5.35"), add: "0" },
      { moreThan: "63400", butNotMoreThan: "208180", subtract: "63400", rate: pctToRate("6.80"), add: "2605.45" },
      { moreThan: "208180", butNotMoreThan: "352630", subtract: "208180", rate: pctToRate("7.85"), add: "12450.49" },
      { moreThan: "352630", butNotMoreThan: null, subtract: "352630", rate: pctToRate("9.85"), add: "23789.82" },
    ],
  },
};

const MN_EDITIONS_BY_YEAR: Record<number, MnYearRates> = {
  [MN_RATES_2026.year]: MN_RATES_2026,
};

export const MN_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "2026 Minnesota Withholding Tax Instructions and Tables, Computer Formula",
  effectiveFrom: "2026-01-01",
  citation:
    "Minnesota Department of Revenue, 2026 Minnesota Withholding Tax Instructions and Tables, "
    + "Computer Formula (p. 34), effective January 1, 2026; Form W-4MN (Rev. 4/26)",
  status: "published",
  region: "MN",
}];

export function mnRatesForPayDate(payDate: string): MnYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = MN_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(MN_WITHHOLDING, year);
  }
  return rates;
}

/**
 * W-4MN marital-status boxes onto the two Step-5 charts.
 *
 * "Married, but withhold at higher Single rate" uses the Single chart — the
 * box's own words. No W-4MN: "withhold tax at the single filing status with
 * zero allowances" (booklet p. 3 / W-4MN employer instructions).
 */
export function mnScheduleFor(maritalStatus: string | null): MnSchedule {
  return maritalStatus === "married" ? "married" : "single";
}

/** Step 5 — the chart. Amounts at or below the first "More than" are zero. */
export function mnAnnualTax(taxable: bigint, schedule: MnSchedule, rates: MnYearRates): bigint {
  if (taxable <= 0n) return 0n;
  for (const band of rates.schedules[schedule]) {
    const floor = U(band.moreThan);
    const cap = band.butNotMoreThan === null ? null : U(band.butNotMoreThan);
    if (taxable > floor && (cap === null || taxable <= cap)) {
      return U(band.add) + mulRateCents(taxable - U(band.subtract), band.rate);
    }
  }
  return 0n;
}

/**
 * Booklet p. 7 Method 2 — flat 6.25% on a supplemental payment paid separately
 * from regular wages. Exported rather than applied: Method 1 (add to regular
 * wages and run the formula) is always permitted, and `compute` does that.
 */
export function mnSupplementalFlat(payDate: string, supplemental: string): string {
  const rates = mnRatesForPayDate(payDate);
  return D(mulRateCents(U(supplemental), rates.supplementalRate));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = mnRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Minnesota withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    return {
      state: "MN", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
      factors: { MN_EXEMPT: "1" },
    };
  }

  const schedule = mnScheduleFor(certificateChoice(input.certificate, "marital_status"));
  factors.MN_SCHEDULE = schedule;
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;

  // Method 1: "Add the supplemental payment to the regular wages."
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("MN_ANNUAL_WAGES", annualWages);

  const annualAllowance = U(rates.allowance) * BigInt(Math.max(allowances, 0));
  trace("MN_ANNUAL_ALLOWANCE", annualAllowance);

  const taxable = max0(annualWages - annualAllowance);
  trace("MN_TAXABLE", taxable);
  if (taxable === 0n) {
    const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
    return {
      state: "MN", year: rates.year, tax: D(extra), taxSupplemental: D(0n),
      factors: { ...factors, MN_ANNUAL_TAX: D(0n), MN_WITHHELD: D(extra) },
    };
  }

  const annualTax = mnAnnualTax(taxable, schedule, rates);
  trace("MN_ANNUAL_TAX", annualTax);

  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("MN_WITHHELD", total);

  return {
    state: "MN",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const MN_WITHHOLDING: UsStateWithholdingEngine = {
  state: "MN",
  label: "Minnesota income tax",
  certificateKey: "us_mn_w4mn",
  ratesModule: RATES_MODULE,
  editions: MN_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Minnesota withholding certificate and region declaration.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's declaration. Shape matches
 * IL_W4 / NC_NC4 / NC_REGION.
 *
 * Sources: Form W-4MN (Rev. 4/26); 2026 Minnesota Withholding Tax
 * Instructions and Tables pp. 3–4; Form MWR for Tax Year 2026.
 */
/** Form W-4MN — Minnesota Employee Withholding Certificate (Rev. 4/26). */
export const MN_CERTIFICATE: PayrollCertificate = {
  key: "us_mn_w4mn",
  form: "W-4MN",
  label: "Minnesota Employee Withholding Certificate",
  scope: { level: "region", region: "MN" },
  purpose: "withholding",
  citation:
    "Minnesota Form W-4MN (Rev. 4/26); 2026 Minnesota Withholding Tax Instructions and Tables "
    + "(Computer Formula p. 34)",
  summary:
    "Sets Minnesota withholding allowances and marital status. If no completed W-4MN is on file, "
    + "the employer must withhold at the single filing status with zero allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "marital_status", label: "Marital status", kind: "choice",
      choices: [
        { value: "single", label: "Single; Married, but legally separated; or Spouse is a nonresident alien" },
        { value: "married", label: "Married" },
        {
          value: "married_higher_single",
          label: "Married, but withhold at higher Single rate",
          help: "Uses the Single Step-5 chart.",
        },
      ],
      default: "single", required: true,
      help: "If the employee does not complete a Form W-4MN, withhold at the single filing status "
        + "with zero allowances.",
    },
    {
      key: "allowances", label: "Line 1 — Minnesota allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "From Section 1 Step F (or the itemized-deductions worksheet Step 10). Worth $5,300 "
        + "a year each in 2026. Default zero: that is the booklet's no-certificate rule.",
    },
    {
      key: "additional_per_period", label: "Line 2 — Additional Minnesota withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "A flat dollar amount, not a percentage. Added after the formula.",
    },
    {
      key: "exempt", label: "Section 2 — Exempt from Minnesota withholding", kind: "flag",
      help: "Boxes A–F. A new W-4MN is due by February 15 each year; without one, withhold as "
        + "single with zero allowances. Reciprocity for Michigan or North Dakota is Form MWR, "
        + "not this box.",
    },
  ],
};

/**
 * Form MWR — Reciprocity Exemption/Affidavit of Residency (tax year 2026).
 *
 * Minnesota's agreements are with Michigan and North Dakota only. Illinois is
 * not one: an Illinois resident working in Minnesota is withheld Minnesota tax
 * in full. Due each year by February 28 (or within 30 days of hire / move).
 */
export const MN_MWR: PayrollCertificate = {
  key: "us_mn_mwr",
  form: "MWR",
  label: "Reciprocity Exemption/Affidavit of Residency (Minnesota)",
  scope: { level: "region", region: "MN" },
  purpose: "non_residence",
  citation:
    "Minnesota Form MWR for Tax Year 2026; 2026 Minnesota Withholding Tax Instructions and "
    + "Tables p. 4, \"Reciprocity for Residents of Michigan or North Dakota\"",
  summary:
    "Claims exemption from Minnesota withholding under the Michigan or North Dakota reciprocity "
    + "agreement. \"If your employees … give you a properly completed Form MWR … each year.\" "
    + "Without it, Minnesota tax is withheld.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "State of permanent residence", kind: "choice",
      choices: [
        { value: "MI", label: "Michigan" },
        { value: "ND", label: "North Dakota" },
      ],
      required: true,
      help: "Minnesota has reciprocal agreements with exactly these two states. The employee must "
        + "return to that residence at least once a month.",
    },
  ],
};

export const MN_REGION: PayrollRegionWithholding = {
  region: "MN",
  label: "Minnesota income tax",
  implemented: true,
  // Booklet p. 4: withhold from a nonresident on Minnesota-source wages unless
  // reciprocity (MI/ND on Form MWR) or expected pay is under $15,300.
  taxesNonresidentWages: true,
  // Booklet p. 5: a Minnesota resident working in another state (other than
  // Michigan or North Dakota) "may be required" to have Minnesota withheld —
  // the employer completes a worksheet. Declared required as the base rule;
  // the worksheet and the reciprocity exception are not implemented.
  residentWithholding: "required",
  residentWithholdingImplemented: false,
  certificateKey: "us_mn_w4mn",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Minnesota Department of Revenue, 2026 Minnesota Withholding Tax Instructions and Tables, "
    + "Computer Formula (p. 34); Form W-4MN (Rev. 4/26)",
};
