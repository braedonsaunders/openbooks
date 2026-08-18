/**
 * Ohio withholding — the state income tax, the school district income taxes,
 * and the municipal income taxes.
 *
 * Sources (fetched from tax.ohio.gov / dam.assets.ohio.gov, not memory):
 *   Employer Withholding Taxes: Optional Computer Formula, Rev. 07/26,
 *     effective August 1, 2026 — the annualized formula this engine computes.
 *   Employer Withholding Taxes: Optional Computer Formula, Rev. 09/25,
 *     effective October 1, 2025 — the edition in force for the first seven
 *     months of 2026.
 *   Employer Withholding Taxes - Percentage Method, effective August 1, 2026
 *     and effective October 1, 2025 — the five printed per-period tables,
 *     transcribed below and cross-checked against the formula.
 *   Summary of School District Income Tax Changes Effective Calendar Year 2026
 *     and "School Districts With an Income Tax as of January 2026" (Ohio
 *     Department of Taxation, December 30, 2025) — all 214 taxing districts,
 *     their rates, and which of the two tax BASES each one uses.
 *   Form IT 4, Employee's Withholding Exemption Certificate (Rev. 01/24).
 *   Ohio Rev. Code Chapter 718 — municipal income taxes.
 *
 * ===========================================================================
 * THREE THINGS OHIO DOES THAT NO EARLIER STATE IN THIS PACK DOES
 * ===========================================================================
 *
 * 1. ITS TABLES CHANGE MID-YEAR, AND THE TRIGGER IS THE PAYROLL PERIOD'S END
 *    DATE — NOT THE PAY DATE.
 *
 *    House Bill 96 (the 2025 biennial budget) cut the rates, and the Department
 *    published a new set "effective August 1, 2026" that applies to any payroll
 *    period ENDING on or after that date, whenever it is paid. Philadelphia's
 *    wage tax also changes mid-year and keys to the PAY date; Ohio keys to the
 *    other end of the period, and the two are days or weeks apart.
 *
 *    So this engine REQUIRES `periodEnd` and refuses without it, the same way
 *    the Yonkers resident surcharge refuses without `regionTax`. Substituting
 *    the pay date would silently pick the NEW, LOWER rates for a period that
 *    ended in July — under-withholding, quietly, for exactly one payroll in the
 *    changeover and for every payroll in a year where the rates move the other
 *    way.
 *
 * 2. ITS SCHOOL DISTRICT TAX HAS TWO DIFFERENT BASES, PER DISTRICT.
 *
 *    A "traditional" district taxes the same base the state does — wages less
 *    the $650-per-exemption allowance. An "earned income only" district taxes
 *    earned income with NO exemption deduction at all (R.C. 5748.01(E)(1) and
 *    (E)(2)). 68 of the 214 taxing districts are earned-income; the other 146
 *    are traditional. That is a fact ABOUT EACH DISTRICT, so it is transcribed
 *    beside the district's rate rather than branched on anywhere: the engine
 *    reads `district.base` and applies the formula the pack declared for it.
 *
 *    Ohio publishes the complete list annually, so this module carries the
 *    complete list. That matters more than it looks: with the whole list in
 *    hand, a four-digit code that is NOT in it means "that district levies no
 *    income tax", which is a real and safe answer. Carrying a partial list
 *    would make the same silence mean "we never heard of it", and the two are
 *    indistinguishable to everything downstream.
 *
 * 3. ITS MUNICIPAL INCOME TAXES ARE NOT ITS OWN.
 *
 *    Several hundred Ohio municipalities levy an income tax under R.C. Chapter
 *    718, each setting its own rate by its own ordinance on its own timetable,
 *    and the Department administers only the net profits tax — for withholding
 *    it directs employers to the municipality or to The Finder. There is no
 *    annual state publication of municipal WITHHOLDING rates to transcribe, and
 *    a list assembled from elsewhere would be wrong for whichever municipality
 *    raised its rate after the release, with nothing in the product able to
 *    tell.
 *
 *    So the rate is EMPLOYER-ENTERED — a `sub_region`-scoped
 *    `payroll_statutory_rates` slot, exactly as Pennsylvania's Act 32 rates are
 *    and for exactly the same reason. `ohMunicipalWithholding` takes the rate
 *    it is given and refuses to invent one. An unentered rate stops the run;
 *    it never becomes a zero.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { certificateAmount, certificateCount } from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  payPeriodFor,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/oh.ts";

/** The five payroll periods Ohio prints percentage-method tables for. */
type OhPeriod = "weekly" | "biweekly" | "semimonthly" | "monthly" | "daily";

const OH_PRINTED_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly", "daily",
];

/**
 * One band of the optional computer formula:
 * for annual taxable wages up to `upTo`, tax = `base` + `rate` × (TW − `over`).
 */
export interface OhFormulaBand {
  /** Null on the top band. INCLUSIVE — "not more than $100,000". */
  upTo: string | null;
  over: string;
  base: string;
  rate: string;
}

/** One printed percentage-method line, per payroll period. */
export interface OhPercentageRow {
  /** Null on the top line. INCLUSIVE — the column is "to ≤". */
  upTo: string | null;
  over: string;
  base: string;
  rate: string;
}

export interface OhEdition {
  /** Applies to payroll periods ENDING on or after this date. */
  effectiveFrom: string;
  /** Exclusive; null while this is the current edition. */
  effectiveTo: string | null;
  label: string;
  citation: string;
  /** R.C. 5747.02 — the annual exemption allowance per exemption claimed. */
  exemptionPerYear: string;
  /** The optional computer formula's annualized bands. */
  formula: readonly OhFormulaBand[];
  /** The printed per-period exemption ("Gross Wage Minus $12.50 for Each"). */
  printedExemption: Readonly<Record<OhPeriod, string>>;
  /** The printed per-period schedules. */
  printedTables: Readonly<Record<OhPeriod, readonly OhPercentageRow[]>>;
}

/**
 * Effective October 1, 2025 — in force for payroll periods ending before
 * 1 August 2026, which is most of the first two thirds of the tax year.
 */
const OH_EDITION_2025_10: OhEdition = {
  effectiveFrom: "2025-10-01",
  effectiveTo: "2026-08-01",
  label: "Ohio withholding tables effective October 1, 2025",
  citation:
    "Ohio Department of Taxation, Employer Withholding Taxes: Optional Computer Formula "
    + "(Rev. 09/25) and Employer Withholding Taxes - Percentage Method, both effective "
    + "October 1, 2025",
  exemptionPerYear: "650",
  formula: [
    { upTo: "26050", over: "0", base: "0", rate: "0.01775" },
    { upTo: "100000", over: "26050", base: "462.39", rate: "0.02990" },
    { upTo: null, over: "100000", base: "2673.50", rate: "0.03640" },
  ],
  printedExemption: {
    weekly: "12.50", biweekly: "25.00", semimonthly: "27.08", monthly: "54.17", daily: "2.50",
  },
  printedTables: {
    weekly: [
      { upTo: "500.96", over: "0", base: "0.00", rate: "0.01775" },
      { upTo: "1923.08", over: "500.96", base: "8.89", rate: "0.02990" },
      { upTo: null, over: "1923.08", base: "51.41", rate: "0.03640" },
    ],
    biweekly: [
      { upTo: "1001.92", over: "0", base: "0.00", rate: "0.01775" },
      { upTo: "3846.15", over: "1001.92", base: "17.78", rate: "0.02990" },
      { upTo: null, over: "3846.15", base: "102.82", rate: "0.03640" },
    ],
    semimonthly: [
      { upTo: "1085.42", over: "0", base: "0.00", rate: "0.01775" },
      { upTo: "4166.67", over: "1085.42", base: "19.27", rate: "0.02990" },
      { upTo: null, over: "4166.67", base: "111.40", rate: "0.03640" },
    ],
    monthly: [
      { upTo: "2170.83", over: "0", base: "0.00", rate: "0.01775" },
      { upTo: "8333.33", over: "2170.83", base: "38.53", rate: "0.02990" },
      { upTo: null, over: "8333.33", base: "222.79", rate: "0.03640" },
    ],
    daily: [
      { upTo: "100.19", over: "0", base: "0.00", rate: "0.01775" },
      { upTo: "384.62", over: "100.19", base: "1.78", rate: "0.02990" },
      { upTo: null, over: "384.62", base: "10.28", rate: "0.03640" },
    ],
  },
};

/** Effective August 1, 2026 — the House Bill 96 rates. */
const OH_EDITION_2026_08: OhEdition = {
  effectiveFrom: "2026-08-01",
  effectiveTo: null,
  label: "Ohio withholding tables effective August 1, 2026 (HB 96)",
  citation:
    "Ohio Department of Taxation, Employer Withholding Taxes: Optional Computer Formula "
    + "(Rev. 07/26) and Employer Withholding Taxes - Percentage Method, both effective "
    + "August 1, 2026, published following the rate reductions in House Bill 96",
  exemptionPerYear: "650",
  formula: [
    { upTo: "26050", over: "0", base: "0", rate: "0.01600" },
    { upTo: "100000", over: "26050", base: "416.80", rate: "0.02990" },
    { upTo: null, over: "100000", base: "2627.91", rate: "0.03400" },
  ],
  printedExemption: {
    weekly: "12.50", biweekly: "25.00", semimonthly: "27.08", monthly: "54.17", daily: "2.50",
  },
  printedTables: {
    weekly: [
      { upTo: "500.96", over: "0", base: "0.00", rate: "0.01600" },
      { upTo: "1923.08", over: "500.96", base: "8.02", rate: "0.02990" },
      { upTo: null, over: "1923.08", base: "50.54", rate: "0.03400" },
    ],
    biweekly: [
      { upTo: "1001.92", over: "0", base: "0.00", rate: "0.01600" },
      { upTo: "3846.15", over: "1001.92", base: "16.03", rate: "0.02990" },
      { upTo: null, over: "3846.15", base: "101.07", rate: "0.03400" },
    ],
    semimonthly: [
      { upTo: "1085.42", over: "0", base: "0.00", rate: "0.01600" },
      { upTo: "4166.67", over: "1085.42", base: "17.37", rate: "0.02990" },
      { upTo: null, over: "4166.67", base: "109.50", rate: "0.03400" },
    ],
    monthly: [
      { upTo: "2170.83", over: "0", base: "0.00", rate: "0.01600" },
      { upTo: "8333.33", over: "2170.83", base: "34.73", rate: "0.02990" },
      { upTo: null, over: "8333.33", base: "218.99", rate: "0.03400" },
    ],
    daily: [
      { upTo: "100.19", over: "0", base: "0.00", rate: "0.01600" },
      { upTo: "384.62", over: "100.19", base: "1.60", rate: "0.02990" },
      { upTo: null, over: "384.62", base: "10.10", rate: "0.03400" },
    ],
  },
};

export const OH_EDITIONS: readonly OhEdition[] = [OH_EDITION_2025_10, OH_EDITION_2026_08];

// ---------------------------------------------------------------------------
// School districts
// ---------------------------------------------------------------------------

/**
 * The two bases a school district income tax can be levied on.
 *
 * `traditional` — R.C. 5748.01(E)(1). The same wage base and the same
 *   exemptions as state withholding.
 * `earned_income` — R.C. 5748.01(E)(2). Earned income only, and NO exemption
 *   deduction: "Withhold at a flat rate using the school district withholding
 *   rate tables, with no reduction or adjustment for personal exemptions."
 */
export type OhSchoolDistrictBase = "traditional" | "earned_income";

export interface OhSchoolDistrict {
  /** The four-digit district number, as Form IT 4 and The Finder print it. */
  code: string;
  /** The Department's own name for the district, expiry note included. */
  name: string;
  /** The rate as the Department prints it, in percent. */
  printedPercent: string;
  rate: string;
  base: OhSchoolDistrictBase;
}

function schoolDistricts(
  rows: readonly (readonly [string, string, string, "T" | "E"])[],
): readonly OhSchoolDistrict[] {
  return rows.map(([code, name, printedPercent, base]) => ({
    code,
    name,
    printedPercent,
    rate: pctToRate(printedPercent),
    base: base === "E" ? "earned_income" : "traditional",
  }));
}

/**
 * Every Ohio school district levying an income tax in calendar year 2026.
 *
 * Transcribed from "School Districts With an Income Tax as of January 2026",
 * Ohio Department of Taxation, December 30, 2025. The Department's own
 * footnotes state the totals this module's test re-counts: 214 districts, of
 * which 68 are taxed on earned income only.
 */
export const OH_SCHOOL_DISTRICTS_2026: readonly OhSchoolDistrict[] = schoolDistricts([
  ["0203", "Bluffton EVSD (expires 2028)", "0.50", "T"],
  ["0204", "Delphos CSD (expires 2030)", "0.50", "T"],
  ["0209", "Spencerville LSD (expires 2027)", "1.00", "T"],
  ["0302", "Hillsdale LSD (expires 2033)", "1.25", "E"],
  ["0303", "Loudonville-Perrysville EVSD", "1.25", "T"],
  ["0404", "Geneva Area CSD (expires 2028)", "1.25", "E"],
  ["0502", "Athens CSD (expires 2028)", "1.00", "E"],
  ["0505", "Trimble LSD (expires 2030)", "1.00", "E"],
  ["0601", "Minster LSD (expires 2031)", "1.00", "T"],
  ["0602", "New Bremen LSD", "1.00", "T"],
  ["0603", "New Knoxville LSD (0.25% expires 2029; 1.00% CPT)", "1.25", "T"],
  ["0604", "St Marys CSD (expires 2028)", "1.00", "E"],
  ["0605", "Wapakoneta CSD", "0.75", "T"],
  ["0606", "Waynesfield-Goshen LSD (expires 2026)", "1.00", "T"],
  ["0905", "Madison LSD", "0.50", "T"],
  ["0907", "New Miami LSD", "1.00", "T"],
  ["0908", "Ross LSD", "1.25", "E"],
  ["0909", "Talawanda CSD", "1.00", "T"],
  ["1102", "Mechanicsburg EVSD (1.00% expires 2041; 0.50% CPT)", "1.50", "T"],
  ["1103", "Triad LSD (0.50% expires 2030; 1.00% CPT)", "1.50", "T"],
  ["1105", "expires 2036; 0.50% CPT)", "1.75", "T"],
  ["1203", "Northeastern LSD (expires 2035)", "1.00", "E"],
  ["1204", "Northwestern LSD", "1.00", "E"],
  ["1205", "Southeastern LSD", "1.00", "T"],
  ["1303", "Clermont-Northeastern LSD", "1.00", "T"],
  ["1305", "Goshen LSD", "1.00", "T"],
  ["1401", "Blanchester LSD (expires 2028)", "1.00", "E"],
  ["1402", "Clinton-Massie LSD (expires 2030)", "1.00", "E"],
  ["1502", "Columbiana EVSD", "1.00", "T"],
  ["1503", "Crestview LSD", "1.00", "T"],
  ["1510", "United LSD", "0.50", "T"],
  ["1701", "Buckeye Central LSD", "1.50", "T"],
  ["1703", "Colonel Crawford LSD", "1.25", "T"],
  ["1704", "Crestline EVSD", "0.25", "E"],
  ["1901", "Ansonia LSD (1.00% expires 2030; 0.75% CPT)", "1.75", "T"],
  ["1902", "Arcanum-Butler LSD (0.75% expires 2030; 0.75% CPT)", "1.50", "T"],
  ["1903", "Franklin Monroe LSD", "0.75", "T"],
  ["1904", "Greenville CSD", "0.50", "T"],
  ["1905", "CPT)", "1.75", "T"],
  ["1906", "Tri-Village LSD", "1.50", "T"],
  ["1907", "Versailles EVSD (expires 2028)", "1.00", "T"],
  ["2001", "Ayersville LSD (expires 2027)", "1.00", "T"],
  ["2002", "Central LSD (0.50% expires 2029; 0.75% CPT)", "1.25", "T"],
  ["2003", "Defiance CSD", "0.50", "T"],
  ["2004", "Hicksville EVSD (0.75% expires 2029; 0.75% CPT)", "1.50", "T"],
  ["2101", "Big Walnut LSD", "0.75", "T"],
  ["2102", "Buckeye Valley LSD", "1.00", "T"],
  ["2301", "Amanda-Clearcreek LSD (expires 2034)", "2.00", "E"],
  ["2302", "Berne Union LSD", "2.00", "E"],
  ["2303", "Bloom-Carroll LSD", "1.25", "T"],
  ["2304", "Fairfield Union LSD (1.00% expires 2036; 1.00% CPT)", "2.00", "T"],
  ["2305", "Lancaster CSD", "1.50", "E"],
  ["2306", "Liberty Union-Thurston LSD", "1.75", "T"],
  ["2307", "Pickerington LSD", "1.00", "T"],
  ["2308", "Walnut Township LSD (expires 2033)", "1.75", "E"],
  ["2402", "Washington Court House CSD (expires 2027)", "1.00", "E"],
  ["2501", "Bexley CSD", "0.75", "T"],
  ["2502", "Canal Winchester LSD", "0.75", "T"],
  ["2509", "Reynoldsburg CSD", "0.50", "T"],
  ["2514", "Westerville CSD (CPT)", "0.75", "E"],
  ["2602", "0.75% CPT)", "1.50", "T"],
  ["2603", "Fayette LSD", "1.00", "T"],
  ["2604", "Pettisville LSD", "1.00", "T"],
  ["2605", "CPT begins 2027)", "1.00", "T"],
  ["2606", "Swanton LSD (expires 2029)", "0.75", "T"],
  ["2607", "Wauseon EVSD (expires 2027)", "1.75", "E"],
  ["2801", "Berkshire LSD", "1.00", "E"],
  ["2902", "Cedar Cliff LSD (0.25% expires 2038; 1.00% CPT)", "1.25", "T"],
  ["2903", "Fairborn CSD", "0.50", "T"],
  ["2904", "Greeneview LSD", "1.00", "T"],
  ["2906", "Xenia Community CSD (expires 2030)", "0.50", "T"],
  ["2907", "Yellow Springs EVSD", "2.00", "T"],
  ["3118", "Southwest LSD", "0.75", "E"],
  ["3122", "Wyoming CSD", "1.25", "T"],
  ["3201", "Arcadia LSD (expires 2029)", "1.00", "T"],
  ["3202", "Arlington LSD", "1.75", "T"],
  ["3203", "Cory-Rawson LSD (0.75% expires 2028; 1.00% CPT)", "1.75", "T"],
  ["3204", "Findlay CSD (CPT)", "1.00", "E"],
  ["3205", "Liberty-Benton LSD (expires 2030)", "0.75", "T"],
  ["3206", "McComb LSD", "1.50", "T"],
  ["3207", "Van Buren LSD (expires 2030)", "1.00", "T"],
  ["3208", "Vanlue LSD", "1.00", "T"],
  ["3301", "Ada EVSD (0.75% expires 2027; 0.75% CPT)", "1.50", "T"],
  ["3302", "Hardin Northern LSD", "1.75", "T"],
  ["3303", "Kenton CSD", "1.00", "T"],
  ["3304", "Ridgemont LSD (0.75% expires 2030; 1.00% CPT)", "1.75", "T"],
  ["3305", "Riverdale LSD (expires 2026)", "1.00", "T"],
  ["3306", "Upper Scioto Valley LSD", "0.50", "T"],
  ["3501", "Holgate LSD", "1.50", "T"],
  ["3502", "Liberty Center LSD", "1.75", "T"],
  ["3504", "Patrick Henry LSD", "1.75", "T"],
  ["3603", "Greenfield EVSD", "1.25", "E"],
  ["3604", "Hillsboro CSD", "1.00", "T"],
  ["3901", "Bellevue CSD (expires 2036)", "0.50", "T"],
  ["3902", "Monroeville LSD", "1.50", "E"],
  ["3903", "New London LSD", "1.00", "T"],
  ["3904", "Norwalk CSD", "0.50", "T"],
  ["3905", "South Central LSD", "1.25", "T"],
  ["3906", "Western Reserve LSD", "1.25", "T"],
  ["3907", "Willard CSD", "0.75", "E"],
  ["4201", "Centerburg LSD", "0.75", "T"],
  ["4202", "Danville LSD (1.25% expires 2034; 0.50% CPT)", "1.75", "T"],
  ["4501", "Granville EVSD (expires 2028)", "0.75", "T"],
  ["4503", "Johnstown-Monroe LSD (expires 2028)", "1.00", "T"],
  ["4506", "Licking Valley LSD", "1.00", "T"],
  ["4507", "Newark CSD", "1.00", "T"],
  ["4508", "North Fork LSD (expires 2031)", "1.00", "E"],
  ["4509", "Northridge LSD (expires 2046)", "0.50", "E"],
  ["4510", "Southwest Licking LSD", "0.75", "T"],
  ["4604", "Riverside LSD", "1.50", "E"],
  ["4712", "Oberlin CSD (0.75% expires 2027; 1.25% CPT)", "2.00", "T"],
  ["4715", "Wellington EVSD", "1.00", "T"],
  ["4901", "Jefferson LSD (expires 2033)", "1.00", "E"],
  ["4902", "2031)", "1.25", "E"],
  ["4903", "London CSD", "1.00", "T"],
  ["4904", "Madison Plains LSD (expires 2033)", "1.25", "E"],
  ["5008", "Sebring LSD (expires 2026)", "1.00", "E"],
  ["5010", "Springfield LSD (expires 2029)", "1.00", "T"],
  ["5101", "Elgin LSD", "0.75", "E"],
  ["5103", "Pleasant LSD (expires 2029)", "1.00", "E"],
  ["5104", "Ridgedale LSD", "1.00", "E"],
  ["5105", "River Valley LSD (expires 2029)", "1.00", "E"],
  ["5204", "Cloverleaf LSD (0.75% expires 2034, 0.25% CPT)", "1.00", "E"],
  ["5401", "Celina CSD (expires 2028)", "1.00", "E"],
  ["5402", "Coldwater EVSD (0.50% expires 2030, 0.50% CPT)", "1.00", "T"],
  ["5403", "Marion LSD (expires 2053)", "0.50", "E"],
  ["5405", "Parkway LSD (expires 2030)", "1.00", "T"],
  ["5406", "Fort Recovery LSD", "1.50", "T"],
  ["5501", "Bethel LSD (expires 2030)", "0.75", "E"],
  ["5502", "Bradford EVSD", "1.75", "T"],
  ["5503", "Covington EVSD (1.25% expires 2030; 0.75% CPT)", "2.00", "T"],
  ["5504", "Miami East LSD", "1.75", "E"],
  ["5505", "Milton Union EVSD (0.75% expires 2030, 1.25% CPT)", "2.00", "E"],
  ["5506", "Newton LSD (0.75% expires 2028; 1.00% CPT)", "1.75", "T"],
  ["5507", "Piqua CSD", "1.25", "T"],
  ["5509", "Troy CSD", "1.50", "E"],
  ["5708", "2031)", "1.25", "T"],
  ["5713", "Valley View LSD", "1.75", "T"],
  ["5901", "Cardington-Lincoln LSD (expires 2028)", "0.75", "E"],
  ["5902", "Highland LSD", "0.50", "T"],
  ["5903", "Mount Gilead EVSD (0.75% CPT)", "0.75", "T"],
  ["5904", "Northmor LSD", "1.00", "T"],
  ["6301", "Antwerp LSD (0.75% expires 2030; 0.75% CPT)", "1.50", "T"],
  ["6302", "Paulding EVSD", "1.00", "T"],
  ["6303", "Wayne Trace LSD (0.75% expires 2031; 0.50% CPT)", "1.25", "T"],
  ["6501", "Circleville CSD", "0.75", "E"],
  ["6502", "Logan Elm LSD (expires 2030)", "1.00", "E"],
  ["6503", "Teays Valley LSD", "1.50", "E"],
  ["6704", "James A Garfield LSD (expires 2028)", "1.50", "E"],
  ["6802", "National Trail LSD (0.75% expires 2030; 1.00% CPT)", "1.75", "T"],
  ["6803", "Eaton CSD (0.75% expires 2030; 0.75% CPT)", "1.50", "T"],
  ["6804", "Preble-Shawnee LSD (0.75% expires 2031; 1.00% CPT)", "1.75", "T"],
  ["6805", "expires 2028)", "1.50", "T"],
  ["6806", "Tri-County North LSD (expires 2029)", "1.00", "E"],
  ["6901", "expires 2032)", "1.00", "T"],
  ["6902", "Continental LSD", "1.00", "T"],
  ["6903", "Jennings LSD (expires 2030)", "0.75", "T"],
  ["6904", "Kalida LSD", "1.00", "T"],
  ["6905", "Leipsic LSD", "0.75", "T"],
  ["6906", "Miller City-New Cleveland LSD", "1.25", "T"],
  ["6907", "Ottawa-Glandorf LSD", "1.50", "T"],
  ["6908", "Ottoville LSD", "0.75", "T"],
  ["6909", "2033)", "1.75", "T"],
  ["7001", "Clear Fork Valley LSD (expires 2037)", "1.00", "E"],
  ["7007", "Plymouth-Shiloh LSD", "1.00", "T"],
  ["7008", "Shelby CSD", "1.00", "T"],
  ["7106", "Union-Scioto LSD (expires 2029)", "0.50", "T"],
  ["7107", "Zane Trace LSD (CPT)", "0.75", "E"],
  ["7201", "CPT)", "1.50", "E"],
  ["7202", "Fremont CSD (expires 2028)", "1.25", "T"],
  ["7203", "Gibsonburg EVSD (expires 2028)", "1.00", "E"],
  ["7204", "Lakota LSD", "1.50", "T"],
  ["7403", "Hopewell-Loudon LSD (expires 2048)", "0.50", "E"],
  ["7404", "New Riegel LSD (0.75% expires 2031; 0.75% CPT)", "1.50", "T"],
  ["7405", "Old Fort LSD", "1.00", "T"],
  ["7406", "Seneca East LSD (expires 2030)", "1.00", "T"],
  ["7407", "Tiffin CSD (expires 2031)", "0.75", "E"],
  ["7501", "Anna LSD", "1.50", "T"],
  ["7502", "Botkins LSD", "1.25", "E"],
  ["7503", "Fairlawn LSD", "0.75", "T"],
  ["7504", "Fort Loramie LSD (expires 2029)", "1.50", "T"],
  ["7505", "Hardin-Houston LSD", "0.75", "T"],
  ["7506", "Jackson Center LSD", "1.50", "E"],
  ["7507", "Russia LSD", "0.75", "T"],
  ["7508", "Sidney CSD (expires 2031)", "0.75", "E"],
  ["7612", "Northwest LSD (expires 2032)", "1.00", "E"],
  ["7711", "Norton CSD", "0.50", "E"],
  ["8001", "Fairbanks LSD (0.25% CPT; 0.75% CPT)", "1.00", "T"],
  ["8003", "North Union LSD", "1.00", "T"],
  ["8101", "Crestview LSD", "1.00", "T"],
  ["8104", "Van Wert CSD", "1.00", "T"],
  ["8301", "Carlisle LSD", "1.00", "T"],
  ["8303", "Kings LSD (CPT)", "1.00", "E"],
  ["8501", "Chippewa LSD (expires 2027)", "1.00", "E"],
  ["8502", "Dalton LSD", "0.75", "T"],
  ["8503", "Green LSD (expires 2028)", "0.50", "E"],
  ["8504", "Norwayne LSD (expires 2028)", "0.75", "E"],
  ["8505", "Northwestern LSD", "1.25", "T"],
  ["8509", "Triway LSD (expires 2045)", "1.00", "E"],
  ["8601", "Bryan CSD", "1.00", "T"],
  ["8602", "Edgerton LSD", "1.00", "T"],
  ["8604", "Millcreek-West Unity LSD", "1.00", "T"],
  ["8605", "Montpelier EVSD", "1.25", "E"],
  ["8607", "Stryker LSD (0.25% expires 2031; 1.25% CPT)", "1.50", "T"],
  ["8701", "Bowling Green CSD (0.75% expires 2030, 0.50% CPT)", "1.25", "T"],
  ["8702", "Eastwood LSD (expires 2031)", "1.00", "E"],
  ["8703", "Elmwood LSD (0.50% expires 2030; 0.75% expires 2031)", "1.25", "T"],
  ["8705", "2034)", "1.25", "E"],
  ["8706", "Northwood LSD", "0.25", "E"],
  ["8707", "Otsego LSD", "1.00", "T"],
  ["8708", "Perrysburg EVSD", "0.50", "T"],
  ["8801", "Carey EVSD (expires 2029)", "1.00", "T"],
  ["8802", "Mohawk LSD (expires 2030)", "1.00", "T"],
  ["8803", "Upper Sandusky EVSD (expires 2029)", "1.25", "T"],
]);

const SCHOOL_DISTRICTS_BY_YEAR: Record<number, readonly OhSchoolDistrict[]> = {
  2026: OH_SCHOOL_DISTRICTS_2026,
};

/**
 * The district's declaration, or null when it levies no income tax.
 *
 * Null is a REAL answer here and only because the transcribed list is the
 * Department's complete one: a four-digit code absent from a complete list is
 * a district with no tax, not a district nobody looked up. A code that is not
 * four digits at all is refused instead — that is a data error, not a
 * jurisdiction.
 */
export function ohSchoolDistrict(payDate: string, code: string): OhSchoolDistrict | null {
  const year = Number(payDate.slice(0, 4));
  const districts = SCHOOL_DISTRICTS_BY_YEAR[year];
  if (!districts) {
    throw new Error(
      `the ${year} Ohio school district income tax rates are not loaded — transcribe "School `
      + `Districts With an Income Tax" for ${year} from tax.ohio.gov into ${RATES_MODULE}. `
      + "Loaded years: " + Object.keys(SCHOOL_DISTRICTS_BY_YEAR).join(", ") + ". Never carry a "
      + "prior year's list forward: districts are added, renewed and allowed to expire every "
      + "election cycle.",
    );
  }
  if (!/^\d{4}$/.test(code)) {
    throw new Error(
      `"${code}" is not an Ohio school district number — the Department numbers every district `
      + "with four digits (Form IT 4, \"School district number (####)\"). Look the employee's "
      + "district up in The Finder at tax.ohio.gov.",
    );
  }
  return districts.find((district) => district.code === code) ?? null;
}

// ---------------------------------------------------------------------------
// Editions
// ---------------------------------------------------------------------------

export const OH_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: OH_EDITION_2026_08.label,
  effectiveFrom: "2026-01-01",
  citation:
    OH_EDITION_2025_10.citation + "; " + OH_EDITION_2026_08.citation
    + "; School Districts With an Income Tax as of January 2026 (December 30, 2025)",
  status: "published",
  region: "OH",
}];

/**
 * How far the transcription reaches, as DATES rather than years.
 *
 * Ohio's editions do not start on 1 January — the current pair took effect on 1
 * October 2025 and 1 August 2026 — so "which years are loaded" is the wrong
 * question to gate on. A payroll period ending 31 December 2025 and paid in
 * January 2026 is covered by the October 2025 tables and must compute; a period
 * ending in 2027 is not covered by anything here, even though the August 2026
 * edition has no printed end date, and must refuse.
 */
const OH_TRANSCRIBED_FROM = OH_EDITION_2025_10.effectiveFrom;
const OH_TRANSCRIBED_THROUGH = "2026-12-31";

/**
 * The edition in force for a payroll period ending on `periodEnd`.
 *
 * Selected by the period end date because that is the Department's own trigger.
 */
export function ohEditionFor(periodEnd: string): OhEdition {
  if (periodEnd > OH_TRANSCRIBED_THROUGH) {
    refuseUntranscribedYear(OH_WITHHOLDING, Number(periodEnd.slice(0, 4)));
  }
  const edition = OH_EDITIONS.find((candidate) =>
    periodEnd >= candidate.effectiveFrom
    && (candidate.effectiveTo == null || periodEnd < candidate.effectiveTo));
  if (!edition) {
    throw new Error(
      `no Ohio withholding table is loaded for a payroll period ending ${periodEnd}. This pack `
      + `carries the sets effective ${OH_TRANSCRIBED_FROM} onwards; the Department revises them `
      + "mid-year and keys each set to the payroll period's END date, so an earlier period needs "
      + `the set that was in force then. Transcribe it from tax.ohio.gov into ${RATES_MODULE}.`,
    );
  }
  return edition;
}

/**
 * The payroll period end date, refusing rather than substituting the pay date.
 *
 * Ohio's own instruction is that a table set applies to payroll periods ENDING
 * on or after its effective date. A pay date is typically days after the period
 * it pays for, so using it would pull the August tables onto a July period at
 * every changeover — a small, silent under-withholding that nothing downstream
 * can detect.
 */
function requirePeriodEnd(input: UsStateWithholdingInput): string {
  if (!input.periodEnd) {
    throw new Error(
      "Ohio withholding tables are keyed to the PAYROLL PERIOD END DATE, not the pay date — the "
      + "Department's 2026 tables apply to \"any payroll ending on or after Aug. 1, 2026\" "
      + "regardless of when it is paid. Supply the period end date; substituting the pay date "
      + "would apply the wrong rate set for one payroll at every mid-year change.",
    );
  }
  return input.periodEnd;
}

// ---------------------------------------------------------------------------
// The state income tax
// ---------------------------------------------------------------------------

function periodsGuard(periodsPerYear: number): void {
  if (!Number.isInteger(periodsPerYear) || periodsPerYear < 1 || periodsPerYear > 2000) {
    throw new Error(`invalid pay periods per year for Ohio withholding: ${periodsPerYear}`);
  }
}

/**
 * The optional computer formula — the method Ohio writes for payroll systems.
 *
 *   TW = (pay per period × PP) − ($650 × number of exemptions)
 *   WD = the band's formula ÷ PP
 *
 * It annualizes, so unlike the five printed per-period tables it answers for
 * ANY pay frequency, and the printed tables are derivable from it (the
 * conformance test derives all fifteen lines of both editions and proves it).
 * That is why this is the method `compute` runs.
 */
export function ohOptionalComputerFormula(input: {
  periodEnd: string;
  periodsPerYear: number;
  /** Gross wages for the period. */
  wages: string;
  exemptions: number;
}): { tax: string; factors: Record<string, string> } {
  const edition = ohEditionFor(input.periodEnd);
  periodsGuard(input.periodsPerYear);
  const factors: Record<string, string> = { OH_EDITION: edition.effectiveFrom };

  const annualWages = U(input.wages) * BigInt(input.periodsPerYear);
  const exemption = U(edition.exemptionPerYear) * BigInt(Math.max(input.exemptions, 0));
  const taxable = max0(annualWages - exemption);
  factors.OH_ANNUAL_EXEMPTION = D(exemption);
  factors.OH_TAXABLE_WAGE = D(taxable);

  const band = edition.formula.find((candidate) =>
    candidate.upTo == null || taxable <= U(candidate.upTo));
  if (!band) {
    throw new Error(
      `no Ohio withholding band covers annual taxable wages of ${D(taxable)} — ${RATES_MODULE}`,
    );
  }
  factors.OH_BAND_RATE = band.rate;
  const annualTax = U(band.base) + mulRateCents(taxable - U(band.over), band.rate);
  factors.OH_ANNUAL_TAX = D(annualTax);
  const tax = divIntCents(annualTax, input.periodsPerYear);
  factors.OH_TAX = D(tax);
  return { tax: D(tax), factors };
}

/**
 * The printed percentage-method table for one of the five periods Ohio prints.
 *
 * Exported for the conformance goldens and for an employer who elects it. NOT
 * wired into `compute`: the two methods are both published and can differ by a
 * cent, and an engine that switched between them on its own would be
 * unreproducible — the same decision California's annualized method got.
 */
export function ohPercentageMethod(input: {
  periodEnd: string;
  periodsPerYear: number;
  wages: string;
  exemptions: number;
}): string {
  const edition = ohEditionFor(input.periodEnd);
  const period = payPeriodFor(input.periodsPerYear);
  if (period == null || !OH_PRINTED_PERIODS.includes(period)) {
    throw new Error(
      `Ohio prints percentage-method tables for ${OH_PRINTED_PERIODS.join(", ")} payroll periods, `
      + `and this payroll runs ${input.periodsPerYear} periods a year. Use the optional computer `
      + "formula, which annualizes and answers for any frequency.",
    );
  }
  const key = period as OhPeriod;
  const exemption = U(edition.printedExemption[key]) * BigInt(Math.max(input.exemptions, 0));
  const taxable = max0(U(input.wages) - exemption);
  const row = edition.printedTables[key].find((candidate) =>
    candidate.upTo == null || taxable <= U(candidate.upTo));
  if (!row) throw new Error(`no Ohio ${key} line covers ${D(taxable)} — ${RATES_MODULE}`);
  return D(U(row.base) + mulRateCents(taxable - U(row.over), row.rate));
}

function computeOh(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const periodEnd = requirePeriodEnd(input);
  const edition = ohEditionFor(periodEnd);

  // Form IT 4 line 4 — the total of lines 1, 2 and 3. With no IT 4 on file the
  // declared default is zero exemptions, which is the certificate's statutory
  // default rather than an assumption made here.
  const exemptions = certificateCount(input.certificate, "total_exemptions") ?? 0;

  // Ohio publishes a separate flat rate for supplemental compensation as an
  // employer ELECTION. It is not transcribed, so supplemental wages are added
  // to the period's wages and run through the same schedule — which is the
  // other published treatment, and the one that needs no election recorded.
  const wages = U(input.wages) + U(input.supplemental ?? "0");

  const { tax, factors } = ohOptionalComputerFormula({
    periodEnd,
    periodsPerYear: input.periodsPerYear,
    wages: D(wages),
    exemptions,
  });

  // Form IT 4 line 5 — "Additional Ohio income tax withholding per pay period".
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  return {
    state: "OH",
    // The TAX year is the year of payment, even where the period that earned it
    // — and therefore the table set — belongs to the year before.
    year: Number(input.payDate.slice(0, 4)),
    tax: D(U(tax) + extra),
    taxSupplemental: D(0n),
    factors,
  };
}

export const OH_WITHHOLDING: UsStateWithholdingEngine = {
  state: "OH",
  label: "Ohio income tax",
  certificateKey: "us_oh_it4",
  ratesModule: RATES_MODULE,
  editions: OH_TAX_YEAR_EDITIONS,
  // The optional computer formula annualizes, so any frequency computes.
  printedPeriods: null,
  compute: computeOh,
};

// ---------------------------------------------------------------------------
// School district income tax
// ---------------------------------------------------------------------------

/**
 * School district withholding, on whichever base the district declares.
 *
 * Residence-based: "School district taxes are based on the employee's
 * residence, not work location." The resolver already carries that — the levy
 * declares `reaches: ["resident"]` — so this function is only ever called for a
 * resident.
 *
 * Traditional districts use "the same wage base and number of exemptions used
 * for regular employer withholding"; earned-income districts withhold "at a
 * flat rate … with no reduction or adjustment for personal exemptions". The
 * difference between the two on a $60,000 salary with three exemptions is
 * $1,950 of base a year, which is real money at 1.75%.
 */
export function ohSchoolDistrictWithholding(input: {
  periodEnd: string;
  periodsPerYear: number;
  wages: string;
  exemptions: number;
  district: OhSchoolDistrict;
}): { tax: string; factors: Record<string, string> } {
  const edition = ohEditionFor(input.periodEnd);
  periodsGuard(input.periodsPerYear);
  const factors: Record<string, string> = {
    OH_SD_CODE: input.district.code,
    OH_SD_BASE: input.district.base,
    OH_SD_RATE: input.district.printedPercent,
  };
  const annualWages = U(input.wages) * BigInt(input.periodsPerYear);
  const base = input.district.base === "traditional"
    ? max0(annualWages - U(edition.exemptionPerYear) * BigInt(Math.max(input.exemptions, 0)))
    : max0(annualWages);
  factors.OH_SD_TAXABLE = D(base);
  const annualTax = mulRateCents(base, input.district.rate);
  const tax = divIntCents(annualTax, input.periodsPerYear);
  factors.OH_SD_TAX = D(tax);
  return { tax: D(tax), factors };
}

// ---------------------------------------------------------------------------
// Municipal income tax
// ---------------------------------------------------------------------------

/**
 * A municipal income tax, at the rate the EMPLOYER supplied.
 *
 * R.C. 718.03 requires an employer to withhold for the municipality the work is
 * performed in (subject to the twenty-day occasional-entrant threshold in R.C.
 * 718.011, which is a day count this engine is not given and therefore does not
 * apply on its own). The base is qualifying wages — Medicare wages, with no
 * exemptions, no standard deduction and no brackets.
 *
 * The rate is not a constant this pack can carry: every municipality sets its
 * own by ordinance. It is refused, by name, when it has not been entered.
 */
export function ohMunicipalWithholding(input: {
  /** Wages sourced to the municipality. */
  wages: string;
  /** The rate from the municipality's ordinance, as a decimal. Required. */
  rate: string | null | undefined;
  /** The municipality, for the refusal. */
  municipality: string;
}): string {
  if (input.rate == null || input.rate === "") {
    throw new Error(
      `no income tax rate has been entered for ${input.municipality} (Ohio). Ohio municipalities `
      + "set their own rates by ordinance and the Department publishes no annual withholding rate "
      + "table for them, so the rate is employer-entered: record it against the jurisdiction "
      + "(statutory rate \"us_oh_municipal\") from the municipality's own ordinance or The Finder. "
      + "Withholding nothing would under-withhold every employee the levy reaches.",
    );
  }
  return D(mulRateCents(max0(U(input.wages)), input.rate));
}
