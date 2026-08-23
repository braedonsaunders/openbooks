/**
 * Indiana income-tax withholding — Departmental Notice #1, the formula method
 * (state rate on wages less the period's deduction constants, plus county tax
 * at the employee's January-1 county).
 *
 * Source (fetched from in.gov/dor, not memory):
 *   Departmental Notice #1, Effective Jan. 1, 2026 (R46 / 01-26),
 *     https://www.in.gov/dor/files/dn01.pdf
 *     — state rate 2.95% (p. 2); Tables A/B/C deduction constants (p. 2);
 *       the worked weekly example (p. 3); all 92 county rates (p. 5).
 *   Form WH-4, State Form 48845 (R10 / 8-23),
 *     https://forms.in.gov/download.aspx?id=2702
 *     — lines 5–10 and the January-1 county-of-residence / county-of-work
 *       status block.
 *
 * The notice's own words for the method:
 *
 *   The deduction constant tables "divide the dollar amount of the
 *   exemption/dependent exemption by the number of pay periods." Table A is
 *   $1,000 a year per WH-4 line 5 exemption; Table B is $1,500 a year per
 *   line 6 additional-dependent exemption AND per line 7 first-time
 *   additional-dependent exemption; Table C is $3,000 a year per line 8
 *   adopted-child exemption. Subtract the sum of those period constants from
 *   gross, then apply 2.95% (state) and the January-1 county rate.
 *
 *   "For one-time or non-periodic payments, such as a bonus check,
 *   withholding should be computed without exemptions."
 *
 *   "Indiana does not follow the allowance for no withholding permitted for
 *   federal purposes under IRC § 3402(n)." With no WH-4 on file there are
 *   no claimed exemptions — the default is ZERO, not one.
 *
 * County tax is a separate levy on the SAME taxable wages. Departmental
 * Notice #1 publishes the complete 2026 list of all 92 counties, so the
 * rates live here as pack constants (not employer-entered). An unknown
 * county code is refused; a missing county ("not applicable" — the employee
 * neither lived nor worked in Indiana on January 1) withholds no county tax.
 * A county rate is never invented and never defaulted.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateCode, certificateCount, certificateFlag, type PayrollCertificate,
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

const RATES_MODULE = "engine/src/payroll/us/states/in.ts";

export interface InYearRates {
  year: number;
  status: "published" | "draft";
  /** Departmental Notice #1: "the state adjusted gross income tax rate … is 2.95%." */
  rate: string;
  /** Table A — WH-4 line 5 personal exemptions, annual, each. */
  personalExemption: string;
  /** Table B — WH-4 line 6 additional dependent AND line 7 first-time, annual, each. */
  additionalDependentExemption: string;
  /** Table C — WH-4 line 8 adopted-child dependent, annual, each. */
  adoptedDependentExemption: string;
}

/**
 * 2026 — Departmental Notice #1 (R46 / 01-26), effective January 1, 2026.
 *
 * "For 2026, the state adjusted gross income tax rate for individuals is 2.95%."
 */
export const IN_RATES_2026: InYearRates = {
  year: 2026,
  status: "published",
  rate: pctToRate("2.95"),
  personalExemption: "1000",
  additionalDependentExemption: "1500",
  adoptedDependentExemption: "3000",
};

/**
 * One Indiana county, as Departmental Notice #1 p. 5 prints it.
 *
 * `rate` is the notice's own decimal (0.016, not 1.6%) — the notice does not
 * print county rates as percents. `changedSinceOct2025` is the asterisk.
 */
export interface InCounty {
  code: string;
  name: string;
  rate: string;
  changedSinceOct2025: boolean;
}

/**
 * All 92 Indiana counties, Departmental Notice #1 (R46 / 01-26) p. 5,
 * "Indiana County Tax Rates: Effective Jan. 1, 2026."
 *
 * Transcribed line-for-line from https://www.in.gov/dor/files/dn01.pdf.
 * The six asterisked counties changed after the October 1, 2025 issue.
 */
export const IN_COUNTIES_2026: readonly InCounty[] = [
  { code: "01", name: "Adams", rate: "0.016", changedSinceOct2025: false },
  { code: "02", name: "Allen", rate: "0.0159", changedSinceOct2025: false },
  { code: "03", name: "Bartholomew", rate: "0.0175", changedSinceOct2025: false },
  { code: "04", name: "Benton", rate: "0.0179", changedSinceOct2025: false },
  { code: "05", name: "Blackford", rate: "0.025", changedSinceOct2025: false },
  { code: "06", name: "Boone", rate: "0.017", changedSinceOct2025: false },
  { code: "07", name: "Brown", rate: "0.025234", changedSinceOct2025: false },
  { code: "08", name: "Carroll", rate: "0.024733", changedSinceOct2025: true },
  { code: "09", name: "Cass", rate: "0.0295", changedSinceOct2025: false },
  { code: "10", name: "Clark", rate: "0.02", changedSinceOct2025: false },
  { code: "11", name: "Clay", rate: "0.0235", changedSinceOct2025: false },
  { code: "12", name: "Clinton", rate: "0.0265", changedSinceOct2025: false },
  { code: "13", name: "Crawford", rate: "0.0165", changedSinceOct2025: false },
  { code: "14", name: "Daviess", rate: "0.015", changedSinceOct2025: false },
  { code: "15", name: "Dearborn", rate: "0.014", changedSinceOct2025: false },
  { code: "16", name: "Decatur", rate: "0.0245", changedSinceOct2025: false },
  { code: "17", name: "DeKalb", rate: "0.0213", changedSinceOct2025: false },
  { code: "18", name: "Delaware", rate: "0.015", changedSinceOct2025: false },
  { code: "19", name: "Dubois", rate: "0.012", changedSinceOct2025: false },
  { code: "20", name: "Elkhart", rate: "0.02", changedSinceOct2025: false },
  { code: "21", name: "Fayette", rate: "0.0282", changedSinceOct2025: false },
  { code: "22", name: "Floyd", rate: "0.0189", changedSinceOct2025: false },
  { code: "23", name: "Fountain", rate: "0.021", changedSinceOct2025: false },
  { code: "24", name: "Franklin", rate: "0.017", changedSinceOct2025: false },
  { code: "25", name: "Fulton", rate: "0.0288", changedSinceOct2025: false },
  { code: "26", name: "Gibson", rate: "0.013", changedSinceOct2025: false },
  { code: "27", name: "Grant", rate: "0.0275", changedSinceOct2025: true },
  { code: "28", name: "Greene", rate: "0.0235", changedSinceOct2025: true },
  { code: "29", name: "Hamilton", rate: "0.011", changedSinceOct2025: false },
  { code: "30", name: "Hancock", rate: "0.0194", changedSinceOct2025: false },
  { code: "31", name: "Harrison", rate: "0.01", changedSinceOct2025: false },
  { code: "32", name: "Hendricks", rate: "0.017", changedSinceOct2025: false },
  { code: "33", name: "Henry", rate: "0.0202", changedSinceOct2025: false },
  { code: "34", name: "Howard", rate: "0.0235", changedSinceOct2025: true },
  { code: "35", name: "Huntington", rate: "0.0195", changedSinceOct2025: false },
  { code: "36", name: "Jackson", rate: "0.021", changedSinceOct2025: false },
  { code: "37", name: "Jasper", rate: "0.02864", changedSinceOct2025: false },
  { code: "38", name: "Jay", rate: "0.025", changedSinceOct2025: false },
  { code: "39", name: "Jefferson", rate: "0.0103", changedSinceOct2025: false },
  { code: "40", name: "Jennings", rate: "0.025", changedSinceOct2025: false },
  { code: "41", name: "Johnson", rate: "0.014", changedSinceOct2025: false },
  { code: "42", name: "Knox", rate: "0.017", changedSinceOct2025: false },
  { code: "43", name: "Kosciusko", rate: "0.01", changedSinceOct2025: false },
  { code: "44", name: "LaGrange", rate: "0.0165", changedSinceOct2025: false },
  { code: "45", name: "Lake", rate: "0.015", changedSinceOct2025: false },
  { code: "46", name: "LaPorte", rate: "0.0145", changedSinceOct2025: false },
  { code: "47", name: "Lawrence", rate: "0.0175", changedSinceOct2025: false },
  { code: "48", name: "Madison", rate: "0.0225", changedSinceOct2025: false },
  { code: "49", name: "Marion", rate: "0.0202", changedSinceOct2025: false },
  { code: "50", name: "Marshall", rate: "0.0125", changedSinceOct2025: false },
  { code: "51", name: "Martin", rate: "0.025", changedSinceOct2025: false },
  { code: "52", name: "Miami", rate: "0.0254", changedSinceOct2025: false },
  { code: "53", name: "Monroe", rate: "0.0214", changedSinceOct2025: false },
  { code: "54", name: "Montgomery", rate: "0.0265", changedSinceOct2025: false },
  { code: "55", name: "Morgan", rate: "0.0272", changedSinceOct2025: false },
  { code: "56", name: "Newton", rate: "0.01", changedSinceOct2025: false },
  { code: "57", name: "Noble", rate: "0.0175", changedSinceOct2025: false },
  { code: "58", name: "Ohio", rate: "0.02", changedSinceOct2025: false },
  { code: "59", name: "Orange", rate: "0.0175", changedSinceOct2025: false },
  { code: "60", name: "Owen", rate: "0.025", changedSinceOct2025: false },
  { code: "61", name: "Parke", rate: "0.0265", changedSinceOct2025: false },
  { code: "62", name: "Perry", rate: "0.014", changedSinceOct2025: false },
  { code: "63", name: "Pike", rate: "0.012", changedSinceOct2025: false },
  { code: "64", name: "Porter", rate: "0.005", changedSinceOct2025: false },
  { code: "65", name: "Posey", rate: "0.0145", changedSinceOct2025: false },
  { code: "66", name: "Pulaski", rate: "0.0285", changedSinceOct2025: false },
  { code: "67", name: "Putnam", rate: "0.023", changedSinceOct2025: false },
  { code: "68", name: "Randolph", rate: "0.03", changedSinceOct2025: false },
  { code: "69", name: "Ripley", rate: "0.0238", changedSinceOct2025: false },
  { code: "70", name: "Rush", rate: "0.0215", changedSinceOct2025: false },
  { code: "71", name: "St. Joseph", rate: "0.0175", changedSinceOct2025: false },
  { code: "72", name: "Scott", rate: "0.0216", changedSinceOct2025: false },
  { code: "73", name: "Shelby", rate: "0.017", changedSinceOct2025: true },
  { code: "74", name: "Spencer", rate: "0.008", changedSinceOct2025: false },
  { code: "75", name: "Starke", rate: "0.0171", changedSinceOct2025: false },
  { code: "76", name: "Steuben", rate: "0.0199", changedSinceOct2025: false },
  { code: "77", name: "Sullivan", rate: "0.017", changedSinceOct2025: false },
  { code: "78", name: "Switzerland", rate: "0.0145", changedSinceOct2025: false },
  { code: "79", name: "Tippecanoe", rate: "0.0128", changedSinceOct2025: false },
  { code: "80", name: "Tipton", rate: "0.026", changedSinceOct2025: false },
  { code: "81", name: "Union", rate: "0.0275", changedSinceOct2025: true },
  { code: "82", name: "Vanderburgh", rate: "0.0125", changedSinceOct2025: false },
  { code: "83", name: "Vermillion", rate: "0.015", changedSinceOct2025: false },
  { code: "84", name: "Vigo", rate: "0.02", changedSinceOct2025: false },
  { code: "85", name: "Wabash", rate: "0.029", changedSinceOct2025: false },
  { code: "86", name: "Warren", rate: "0.0212", changedSinceOct2025: false },
  { code: "87", name: "Warrick", rate: "0.01", changedSinceOct2025: false },
  { code: "88", name: "Washington", rate: "0.02", changedSinceOct2025: false },
  { code: "89", name: "Wayne", rate: "0.0125", changedSinceOct2025: false },
  { code: "90", name: "Wells", rate: "0.021", changedSinceOct2025: false },
  { code: "91", name: "White", rate: "0.0232", changedSinceOct2025: false },
  { code: "92", name: "Whitley", rate: "0.016829", changedSinceOct2025: false },
];

const IN_COUNTY_BY_CODE = new Map(IN_COUNTIES_2026.map((county) => [county.code, county]));

const IN_EDITIONS_BY_YEAR: Record<number, InYearRates> = {
  [IN_RATES_2026.year]: IN_RATES_2026,
};

const IN_COUNTIES_BY_YEAR: Record<number, readonly InCounty[]> = {
  2026: IN_COUNTIES_2026,
};

export const IN_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Departmental Notice #1 (R46 / 01-26)",
  effectiveFrom: "2026-01-01",
  citation:
    "Indiana Department of Revenue, Departmental Notice #1, Effective Jan. 1, 2026 "
    + "(R46 / 01-26) — state rate 2.95%, Tables A/B/C and the weekly worked example "
    + "(pp. 2–3); Indiana County Tax Rates effective Jan. 1, 2026 (p. 5)",
  status: "published",
  region: "IN",
}];

export function inRatesForPayDate(payDate: string): InYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = IN_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(IN_WITHHOLDING, year);
  }
  return rates;
}

/**
 * The county Departmental Notice #1 names for an employee.
 *
 * "If an individual resides in an Indiana county on Jan. 1, the rate
 * corresponds to that county of residence. If the [individual] resides
 * out-of-state on Jan. 1 but has his or her principal place of work or
 * business in an Indiana county as of Jan. 1, he or she is subject to county
 * tax at the rate corresponding to that Indiana county."
 *
 * A blank / "NA" / "not applicable" answer is not a county. An answer that
 * is not one of the 92 published codes is refused rather than guessed.
 */
export function inApplicableCounty(
  payDate: string,
  residenceCounty: string | null | undefined,
  workCounty: string | null | undefined,
): InCounty | null {
  const year = Number(payDate.slice(0, 4));
  if (!IN_COUNTIES_BY_YEAR[year]) {
    refuseUntranscribedYear(IN_WITHHOLDING, year);
  }
  const residence = normalizeCountyAnswer(residenceCounty);
  if (residence) return inCounty(year, residence);
  const work = normalizeCountyAnswer(workCounty);
  if (work) return inCounty(year, work);
  return null;
}

export function inCounty(year: number, code: string): InCounty {
  const list = IN_COUNTIES_BY_YEAR[year];
  if (!list) {
    refuseUntranscribedYear(IN_WITHHOLDING, year);
  }
  const county = IN_COUNTY_BY_CODE.get(code) ?? IN_COUNTY_BY_CODE.get(code.padStart(2, "0"));
  if (!county || year !== 2026) {
    throw new Error(
      `"${code}" is not an Indiana county code published in Departmental Notice #1 for ${year} `
      + `(${RATES_MODULE}). The notice lists all 92 counties by two-digit code (01–92); an `
      + "unknown code is not a zero rate.",
    );
  }
  return county;
}

function normalizeCountyAnswer(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || /^n\/?a$/i.test(trimmed) || /^not\s+applicable$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export interface InExemptionCounts {
  personal: number;
  additionalDependent: number;
  firstTimeDependent: number;
  adoptedDependent: number;
}

/**
 * Period taxable wages — the notice's "Taxable Income" line.
 *
 * Annual exemptions ÷ pay periods, rounded to the cent (the deduction-constant
 * tables are that quotient), then subtracted from periodic wages. Floored at
 * zero: the notice never prints a negative taxable and a negative would refund
 * state tax the employer never withheld.
 */
export function inPeriodTaxable(input: {
  payDate: string;
  periodsPerYear: number;
  wages: string;
  exemptions: InExemptionCounts;
}): { taxable: bigint; periodExemption: bigint; factors: Record<string, string> } {
  const rates = inRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Indiana withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const annualExemption =
    U(rates.personalExemption) * BigInt(Math.max(input.exemptions.personal, 0))
    + U(rates.additionalDependentExemption) * BigInt(Math.max(input.exemptions.additionalDependent, 0))
    + U(rates.additionalDependentExemption) * BigInt(Math.max(input.exemptions.firstTimeDependent, 0))
    + U(rates.adoptedDependentExemption) * BigInt(Math.max(input.exemptions.adoptedDependent, 0));
  const periodExemption = divIntCents(annualExemption, P);
  factors.IN_ANNUAL_EXEMPTION = D(annualExemption);
  factors.IN_PERIOD_EXEMPTION = D(periodExemption);
  const taxable = max0(U(input.wages) - periodExemption);
  factors.IN_TAXABLE = D(taxable);
  return { taxable, periodExemption, factors };
}

function exemptionsFromCertificate(certificate: UsStateWithholdingInput["certificate"]): InExemptionCounts {
  return {
    personal: certificateCount(certificate, "personal_exemptions") ?? 0,
    additionalDependent: certificateCount(certificate, "additional_dependent_exemptions") ?? 0,
    firstTimeDependent: certificateCount(certificate, "first_time_dependent_exemptions") ?? 0,
    adoptedDependent: certificateCount(certificate, "adopted_dependent_exemptions") ?? 0,
  };
}

/**
 * County income tax on the same taxable wages the state tax used.
 *
 * Extra county withholding (WH-4 line 10) is added AFTER the rate.
 */
export function inCountyWithholding(input: {
  payDate: string;
  periodsPerYear: number;
  wages: string;
  exemptions: InExemptionCounts;
  county: InCounty;
  additionalPerPeriod?: string;
}): { tax: string; factors: Record<string, string> } {
  const { taxable, factors } = inPeriodTaxable(input);
  factors.IN_COUNTY_CODE = input.county.code;
  factors.IN_COUNTY_RATE = input.county.rate;
  const tax = mulRateCents(taxable, input.county.rate);
  const extra = U(input.additionalPerPeriod ?? "0");
  const total = tax + extra;
  factors.IN_COUNTY_TAX = D(total);
  return { tax: D(total), factors };
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = inRatesForPayDate(input.payDate);
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("IN_EXEMPT", 1n);
    return { state: "IN", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const exemptions = exemptionsFromCertificate(input.certificate);
  const { taxable, factors: taxableFactors } = inPeriodTaxable({
    payDate: input.payDate,
    periodsPerYear: input.periodsPerYear,
    wages: input.wages,
    exemptions,
  });
  Object.assign(factors, taxableFactors);

  const tax = mulRateCents(taxable, rates.rate);
  trace("IN_STATE_TAX", tax);

  // Bonus / non-periodic: "withholding should be computed without exemptions."
  const supplemental = U(input.supplemental ?? "0");
  const taxSupplemental = mulRateCents(supplemental, rates.rate);
  trace("IN_SUPPLEMENTAL_TAX", taxSupplemental);

  // WH-4 line 9 — additional STATE withholding, added AFTER the rate.
  const extra = U(certificateAmount(input.certificate, "additional_state_per_period") ?? "0");
  const total = tax + taxSupplemental + extra;
  trace("IN_WITHHELD", total);

  return {
    state: "IN",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(taxSupplemental),
    factors,
  };
}

export const IN_WITHHOLDING: UsStateWithholdingEngine = {
  state: "IN",
  label: "Indiana income tax",
  certificateKey: "us_in_wh4",
  ratesModule: RATES_MODULE,
  editions: IN_TAX_YEAR_EDITIONS,
  // The notice's tables are the annual exemption ÷ P, so any frequency computes.
  printedPeriods: null,
  compute,
};

/** Resolve the WH-4 county answers the way Departmental Notice #1 directs. */
export function inCountyFromCertificate(
  payDate: string,
  certificate: UsStateWithholdingInput["certificate"],
): InCounty | null {
  return inApplicableCounty(
    payDate,
    certificateCode(certificate, "residence_county"),
    certificateCode(certificate, "work_county"),
  );
}

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Indiana withholding declarations — Form WH-4 and the state + 92-county region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form WH-4, State Form 48845 (R10 / 8-23). */
export const IN_CERTIFICATE: PayrollCertificate = {
  key: "us_in_wh4",
  form: "WH-4",
  label: "Employee's Withholding Exemption and County Status Certificate (Indiana)",
  scope: { level: "region", region: "IN" },
  purpose: "withholding",
  citation:
    "Indiana Form WH-4, State Form 48845 (R10 / 8-23); Departmental Notice #1 "
    + "(R46 / 01-26), Effective Jan. 1, 2026",
  summary:
    "Sets Indiana state and county withholding exemptions and the January-1 county of "
    + "residence and of principal employment. With no WH-4 on file there are no claimed "
    + "exemptions — Departmental Notice #1 does not follow the federal IRC § 3402(n) "
    + "allowance for no withholding.",
  storage: "certificate_rows",
  fields: [
    {
      key: "residence_county",
      label: "Indiana County of Residence as of January 1",
      kind: "code",
      subRegion: { side: "residence" },
      help:
        "The two-digit county code from Departmental Notice #1 (01–92), or blank / "
        + "\"not applicable\" if the employee did not live in Indiana on January 1. "
        + "A move after January 1 does not change the county until the next calendar year.",
    },
    {
      key: "work_county",
      label: "Indiana County of Principal Employment as of January 1",
      kind: "code",
      subRegion: { side: "work" },
      help:
        "The two-digit county code of the Indiana county where the employee principally "
        + "worked on January 1. Used only when the employee resided out of state on "
        + "January 1 — Departmental Notice #1 then withholds that county's rate.",
    },
    {
      key: "personal_exemptions",
      label: "Line 5 — Total personal exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help:
        "The sum of WH-4 lines 1–4 (self, spouse, dependents, age 65 / blind). Worth "
        + "$1,000 a year each (Table A). Default zero: no certificate means no claimed "
        + "exemptions.",
    },
    {
      key: "additional_dependent_exemptions",
      label: "Line 6 — Additional dependent exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help: "Worth $1,500 a year each (Table B). A qualifying dependent child already counted on line 3.",
    },
    {
      key: "first_time_dependent_exemptions",
      label: "Line 7 — First-time additional dependent exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help:
        "Worth $1,500 a year each (Table B). Good only for the calendar year the WH-4 "
        + "claiming it is submitted. A new WH-4 is required each year this is claimed.",
    },
    {
      key: "adopted_dependent_exemptions",
      label: "Line 8 — Adopted qualifying dependent exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help: "Worth $3,000 a year each (Table C). The child must also be counted on lines 3 and 6.",
    },
    {
      key: "additional_state_per_period",
      label: "Line 9 — Additional state withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the 2.95% rate — a flat dollar amount, not a taxable adjustment.",
    },
    {
      key: "additional_county_per_period",
      label: "Line 10 — Additional county withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the county rate. It does not change state withholding.",
    },
    {
      key: "exempt",
      label: "Exempt from Indiana withholding (WH-4MIL / WH-4AFF)",
      kind: "flag",
      help:
        "WH-4MIL military-spouse earned-income exemption, or a WH-4AFF 30-day "
        + "nonresident waiver the employer is honoring. Departmental Notice #1 does "
        + "not otherwise permit a federal-style exempt claim.",
    },
  ],
};

const IN_COUNTY_LEVIES = IN_COUNTIES_2026.map((county) => ({
  code: county.code,
  label: `${county.name} County income tax`,
  kind: "county",
  // Residents on the January-1 residence county; out-of-state January-1
  // residents on the January-1 Indiana work county. Both sides are declared
  // because the notice reaches both populations, at the same published rate.
  reaches: ["resident", "nonresident"] as const,
  rateSource: { kind: "pack" } as const,
  certificateKey: "us_in_wh4",
  citation:
    `Indiana Department of Revenue, Departmental Notice #1 (R46 / 01-26) p. 5 — ${county.name} `
    + `County (code ${county.code}), rate ${county.rate}`
    + (county.changedSinceOct2025 ? ", changed since the Oct. 1, 2025 issue" : ""),
  implemented: true,
}));

export const IN_REGION: PayrollRegionWithholding = {
  region: "IN",
  label: "Indiana income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by Departmental Notice #1: whether an Indiana resident's
  // wages earned entirely outside Indiana must be withheld on by an Indiana
  // employer. Declared unknown rather than guessed.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_in_wh4",
  subRegions: IN_COUNTY_LEVIES,
  // Departmental Notice #1: withhold the January-1 RESIDENCE county when the
  // employee lived in Indiana; otherwise the January-1 Indiana WORK county.
  // `residence_only` is the in-state half of that rule. The out-of-state-worker
  // half is `inApplicableCounty` in states/in.ts — a blank residence county
  // falls through to the work county. Do not switch this to `both` or
  // `higher_rate`: an Indiana resident who works in another Indiana county
  // owes only the residence county.
  subRegionConflictRule: "residence_only",
  citation:
    "Indiana Department of Revenue, Departmental Notice #1 (R46 / 01-26), Effective "
    + "Jan. 1, 2026; Form WH-4, State Form 48845 (R10 / 8-23)",
};
