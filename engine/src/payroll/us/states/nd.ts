/**
 * North Dakota income-tax withholding — 2026 Section 2 percentage method
 * (Forms W-4 for 2020 and after).
 *
 * Source (fetched from tax.nd.gov, not memory):
 *   North Dakota Income Tax Withholding Rates and Instructions, wages paid
 *     in 2026,
 *     https://www.tax.nd.gov/sites/www/files/documents/forms/individual/2026-iit/2026-income-tax-withholding-rates-booklet.pdf
 *     — Section 2 Percentage Method Worksheet; Annual Percentage Method
 *       Tables (Single / Married Filing Jointly / Head of Household);
 *       Payroll Period Table; no W-4 → treat as single; round the period
 *       amount to the nearest dollar.
 *
 * A pre-2020 Form W-4 uses Section 1's percentage method and its allowance
 * table; a 2020-or-later W-4 uses the Section 2 annual method.
 *
 * The booklet's Section 2 worked example prints line 4 as $734.00 on
 * $93,600 Single. The Single table's own figures on that same $93,600 are
 * $35,975 × 1.95% = $701.51. This engine follows the table, not the
 * worksheet typo. The wage-bracket cell for $1,800–$1,825 weekly Single
 * is the booklet's printed $14 — a different method.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { PayrollError } from "../../error.ts";
import { D, divIntCents, mulRateCents, U } from "../../canada/decimal.ts";
import { roundDiv } from "../../../money/money.ts";
import {
  certificateAmount, certificateChoice, certificateFlag, type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import { requireMilitarySpouseEligibility } from "./military-spouse.ts";
import {
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/nd.ts";
const DOLLAR = 10_000n;

const ND_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "daily",
];

export type NdFilingStatus = "single" | "married_joint" | "head_household";

interface NdBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

export interface NdYearRates {
  year: number;
  status: "published" | "draft";
  single: readonly NdBracket[];
  marriedJoint: readonly NdBracket[];
  headHousehold: readonly NdBracket[];
}

const R0 = pctToRate("0");
const R195 = pctToRate("1.95");
const R250 = pctToRate("2.50");

interface NdLegacyPeriodRates {
  allowance: string;
  single: { firstLimit: string; secondLimit: string; topBase: string };
  married: { firstLimit: string; secondLimit: string; topBase: string };
}

/** 2026 Section 1 percentage-method tables for 2019-or-earlier W-4s. */
const ND_LEGACY_PERIOD_RATES: Readonly<Record<Exclude<UsStatePayPeriod, "daily"> | "daily", NdLegacyPeriodRates>> = {
  weekly: { allowance: "97", single: { firstLimit: "1108", secondLimit: "4970", topBase: "75.31" }, married: { firstLimit: "1106", secondLimit: "3241", topBase: "41.63" } },
  biweekly: { allowance: "194", single: { firstLimit: "2216", secondLimit: "9940", topBase: "150.62" }, married: { firstLimit: "2212", secondLimit: "6482", topBase: "83.27" } },
  semimonthly: { allowance: "210", single: { firstLimit: "2401", secondLimit: "10769", topBase: "163.18" }, married: { firstLimit: "2396", secondLimit: "7022", topBase: "90.21" } },
  monthly: { allowance: "420", single: { firstLimit: "4802", secondLimit: "21538", topBase: "326.35" }, married: { firstLimit: "4792", secondLimit: "14044", topBase: "180.41" } },
  quarterly: { allowance: "1268", single: { firstLimit: "14406", secondLimit: "64613", topBase: "979.04" }, married: { firstLimit: "14375", secondLimit: "42131", topBase: "541.24" } },
  semiannual: { allowance: "2525", single: { firstLimit: "28813", secondLimit: "129225", topBase: "1958.03" }, married: { firstLimit: "28750", secondLimit: "84263", topBase: "1082.50" } },
  annual: { allowance: "5050", single: { firstLimit: "57625", secondLimit: "258450", topBase: "3916.09" }, married: { firstLimit: "57500", secondLimit: "168525", topBase: "2164.99" } },
  daily: { allowance: "19", single: { firstLimit: "222", secondLimit: "994", topBase: "15.05" }, married: { firstLimit: "221", secondLimit: "648", topBase: "8.33" } },
};

export const ND_RATES_2026: NdYearRates = {
  year: 2026,
  status: "published",
  single: [
    { over: "0", notOver: "57625", base: "0", rate: R0 },
    { over: "57625", notOver: "258450", base: "0", rate: R195 },
    { over: "258450", notOver: null, base: "3916.09", rate: R250 },
  ],
  marriedJoint: [
    { over: "0", notOver: "57500", base: "0", rate: R0 },
    { over: "57500", notOver: "168525", base: "0", rate: R195 },
    { over: "168525", notOver: null, base: "2164.99", rate: R250 },
  ],
  headHousehold: [
    { over: "0", notOver: "78475", base: "0", rate: R0 },
    { over: "78475", notOver: "289675", base: "0", rate: R195 },
    { over: "289675", notOver: null, base: "4118.40", rate: R250 },
  ],
};

const ND_EDITIONS_BY_YEAR: Record<number, NdYearRates> = {
  [ND_RATES_2026.year]: ND_RATES_2026,
};

export const ND_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "North Dakota Income Tax Withholding Rates and Instructions (2026) — Section 2",
  effectiveFrom: "2026-01-01",
  citation:
    "North Dakota Office of State Tax Commissioner, Income Tax Withholding "
    + "Rates and Instructions for wages paid in 2026 — Section 2 percentage "
    + "method, Annual Percentage Method Tables, $1,800 weekly Single worksheet",
  status: "published",
  region: "ND",
}];

export function ndRatesForPayDate(payDate: string): NdYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = ND_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(ND_WITHHOLDING, year);
  }
  return rates;
}

export function ndRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

function bracketsFor(status: NdFilingStatus, rates: NdYearRates): readonly NdBracket[] {
  if (status === "married_joint") return rates.marriedJoint;
  if (status === "head_household") return rates.headHousehold;
  return rates.single;
}

export function ndAnnualTax(taxable: bigint, status: NdFilingStatus, rates: NdYearRates): bigint {
  if (taxable <= 0n) return 0n;
  const brackets = bracketsFor(status, rates);
  let chosen = brackets[0]!;
  for (const bracket of brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  if (chosen.rate === R0) return 0n;
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = ndRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  const period = payPeriodFor(P);
  if (!period || !ND_PERIODS.includes(period) || (period === "daily" && P !== 260)) {
    refuseUnprintedPeriod(ND_WITHHOLDING, P);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const militarySpouseCertificate = input.supportingCertificates?.us_nd_ndwm;
  if (militarySpouseCertificate?.onFile) {
    requireMilitarySpouseEligibility(militarySpouseCertificate, "North Dakota", [
      { key: "employee_is_civilian_spouse", description: "the employee is a civilian married to an active-duty U.S. Armed Forces servicemember" },
      { key: "both_domiciled_outside_nd", description: "the employee and servicemember spouse are domiciled outside North Dakota" },
      { key: "servicemember_stationed_in_nd", description: "the spouse's permanent duty station is in North Dakota" },
      { key: "employee_present_solely_to_accompany", description: "the employee is residing and working in North Dakota solely to be with the servicemember" },
      { key: "dependent_military_id_attached", description: "a copy of the employee's dependent military ID card is attached" },
    ]);
    trace("ND_MILITARY_SPOUSE_EXEMPT", 1n);
    return { state: "ND", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  if (certificateFlag(input.certificate, "exempt")) {
    trace("ND_EXEMPT", 1n);
    return { state: "ND", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // Guideline p. 2 reservation exception: wages paid to an enrolled tribal
  // member who lives on a reservation are exempt ONLY for services performed
  // on that reservation. The exemption is wage-scoped, never pay-period-wide:
  // off-reservation wages withhold normally.
  const grossWages = U(input.wages) + U(input.supplemental ?? "0");
  let wages = grossWages;
  const tribalCertificate = input.supportingCertificates?.[ND_TRIBAL_KEY];
  if (tribalCertificate?.onFile) {
    const unmet = ND_TRIBAL_FACTS.filter((fact) => !certificateFlag(tribalCertificate, fact.key));
    if (unmet.length > 0) {
      throw new PayrollError(
        "North Dakota reservation exemption requires proof that "
        + unmet.map((fact) => fact.description).join("; "),
      );
    }
    const reservationStr = certificateAmount(tribalCertificate, "reservation_source_wages");
    if (reservationStr == null) {
      throw new PayrollError(
        "North Dakota reservation exemption needs the reservation-source wages for this period; "
        + "record where the services were performed before calculating — refused by name",
      );
    }
    const reservationWages = U(reservationStr);
    if (reservationWages > grossWages) {
      throw new PayrollError(
        `North Dakota reservation-source wages of ${D(reservationWages)} exceed this period's `
        + `wages of ${D(grossWages)}; correct the work-location record before calculating — refused by name`,
      );
    }
    wages = grossWages - reservationWages;
    trace("ND_TRIBAL_SOURCE_WAGES", reservationWages);
  }

  const legacyW4 = input.federalLegacyW4;
  if (legacyW4) {
    const legacyRates = ND_LEGACY_PERIOD_RATES[period];
    const allowance = U(legacyRates.allowance) * BigInt(legacyW4.allowances);
    const taxableWages = wages;
    const taxableAfterAllowances = taxableWages > allowance ? taxableWages - allowance : 0n;
    const schedule = legacyW4.status === "married" ? legacyRates.married : legacyRates.single;
    const unroundedTax = taxableAfterAllowances <= U(schedule.firstLimit)
      ? 0n
      : taxableAfterAllowances <= U(schedule.secondLimit)
        ? mulRateCents(taxableAfterAllowances - U(schedule.firstLimit), R195)
        : U(schedule.topBase) + mulRateCents(taxableAfterAllowances - U(schedule.secondLimit), R250);
    const roundedTax = ndRoundToDollar(unroundedTax);
    const periodTax = roundedTax < U("1") ? 0n : roundedTax;
    const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
    const total = periodTax + extra;
    factors.ND_W4_METHOD = "pre_2020_section_1";
    trace("ND_W4_ALLOWANCE", allowance);
    trace("ND_W4_TAXABLE", taxableAfterAllowances);
    trace("ND_W4_TAX", periodTax);
    trace("ND_WITHHELD", total);
    return {
      state: "ND", year: rates.year, tax: D(total), taxSupplemental: D(0n), factors,
    };
  }

  // Newly hired with no W-4: "treat as a single person".
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as NdFilingStatus;
  const annualWages = wages * BigInt(P);
  trace("ND_ANNUAL_WAGES", annualWages);

  const annualTax = ndAnnualTax(annualWages, status, rates);
  trace("ND_ANNUAL_TAX", annualTax);
  const periodTax = ndRoundToDollar(divIntCents(annualTax, P));
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("ND_WITHHELD", total);

  return {
    state: "ND",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above. Terms are the Section 2 percentage method worksheet's own —
 * see the module header.
 */
export const ND_FACTOR_LABELS: Readonly<Record<string, string>> = {
  ND_EXEMPT: "Exempt from North Dakota withholding",
  ND_W4_METHOD: "North Dakota federal W-4 withholding method",
  ND_W4_ALLOWANCE: "North Dakota pre-2020 W-4 allowance amount",
  ND_W4_TAXABLE: "North Dakota wages after pre-2020 W-4 allowances",
  ND_W4_TAX: "North Dakota tax from pre-2020 W-4 method",
  ND_TRIBAL_SOURCE_WAGES: "North Dakota reservation-source wages exempt this period",
  ND_ANNUAL_WAGES: "North Dakota annualized wages",
  ND_ANNUAL_TAX: "North Dakota tax (annual)",
  ND_WITHHELD: "North Dakota tax withheld this period",
};

const ND_TRIBAL_KEY = "us_nd_tribal";

/** Eligibility facts for the reservation-source exemption, Guideline p. 2. */
const ND_TRIBAL_FACTS: readonly { key: string; description: string }[] = [
  {
    key: "enrolled_member",
    description: "the employee is an enrolled member of a federally recognized Indian tribe",
  },
  {
    key: "lives_on_reservation",
    description: "the employee lives on an Indian reservation",
  },
];

export const ND_WITHHOLDING: UsStateWithholdingEngine = {
  state: "ND",
  label: "North Dakota income tax",
  certificateKey: "us_nd_w4",
  ratesModule: RATES_MODULE,
  editions: ND_TAX_YEAR_EDITIONS,
  printedPeriods: ND_PERIODS,
  supportingCertificateKeys: ["us_nd_ndwm", ND_TRIBAL_KEY],
  taxableWageBases: {
    income: "state:US:ND:income", nonPeriodic: "state:US:ND:nonPeriodic",
  },
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * North Dakota withholding declarations — federal Form W-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/**
 * North Dakota publishes no state withholding certificate. The 2026 booklet
 * withholds from the federal Form W-4. Section 2 (2020 and after) is the
 * automated-payroll method this pack computes.
 */
export const ND_CERTIFICATE: PayrollCertificate = {
  key: "us_nd_w4",
  form: "W-4",
  label: "Federal Form W-4 (North Dakota withholding)",
  scope: { level: "region", region: "ND" },
  purpose: "withholding",
  citation:
    "North Dakota Office of State Tax Commissioner, Income Tax Withholding "
    + "Rates and Instructions for wages paid in 2026 — Section 2; federal Form W-4",
  summary:
    "North Dakota has no state W-4. Section 2 withholds from the federal W-4 "
    + "Step 1(c) filing status. A newly hired employee who has not submitted "
    + "a W-4 is treated as single.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Federal W-4 Step 1(c) — Filing status",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single or married filing separately" },
        { value: "married_joint", label: "Married filing jointly" },
        { value: "head_household", label: "Head of household" },
      ],
      help:
        "The filing status checked on Form W-4 Step 1(c). Section 2 prints "
        + "a separate Annual Percentage Method Table for each. Default Single "
        + "is the booklet's own rule when no W-4 is on file.",
    },
    {
      key: "additional_per_period",
      label: "Additional North Dakota withholding each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "The booklet asks the employer to accommodate an employee's request "
        + "for additional North Dakota withholding. Added AFTER the period "
        + "amount is rounded to the nearest whole dollar.",
    },
    {
      key: "exempt",
      label: "Exempt from North Dakota withholding",
      kind: "flag",
      help:
        "A current exempt claim withholds zero. North Dakota publishes no "
        + "separate exemption form; dating any lapse is certificate "
        + "administration.",
    },
  ],
};

/** North Dakota Form NDW-M for an eligible civilian spouse of a servicemember. */
export const ND_NDWM_CERTIFICATE: PayrollCertificate = {
  key: "us_nd_ndwm",
  form: "NDW-M",
  label: "Exemption from Withholding for a Qualifying Military Spouse",
  scope: { level: "region", region: "ND" },
  purpose: "exemption",
  validity: { kind: "following_year_date", monthDay: "01-31" },
  citation: "North Dakota Form NDW-M (SFN 28720, 12/2023); Income Tax Withholding & Information Returns Guideline, p. 3",
  summary: "File each calendar year and attach the employee's dependent military ID. Renew by January 31 to continue the exemption.",
  storage: "certificate_rows",
  fields: [
    { key: "employee_is_civilian_spouse", label: "Employee is a civilian married to an active-duty U.S. Armed Forces servicemember", kind: "flag", required: true, help: "NDW-M eligibility statement 1." },
    { key: "both_domiciled_outside_nd", label: "Employee and servicemember spouse are domiciled outside North Dakota", kind: "flag", required: true, help: "NDW-M eligibility statement 2; spouses need not share the same non-North-Dakota domicile." },
    { key: "servicemember_stationed_in_nd", label: "Spouse's permanent duty station is in North Dakota", kind: "flag", required: true, help: "NDW-M eligibility statement 3." },
    { key: "employee_present_solely_to_accompany", label: "Employee resides and works in North Dakota solely to be with the servicemember", kind: "flag", required: true, help: "NDW-M eligibility statement 4." },
    { key: "dependent_military_id_attached", label: "Copy of employee's dependent military ID card is attached", kind: "flag", required: true, help: "NDW-M instructions require an attached copy of the dependent military ID card." },
  ],
};

/**
 * North Dakota reservation-source wage exemption attestation. The state
 * publishes no form for it — the employer keeps the eligibility facts with
 * its records — so only the reservation-source wages for the period are
 * exempt and every other wage withholds normally.
 */
export const ND_TRIBAL_CERTIFICATE: PayrollCertificate = {
  key: ND_TRIBAL_KEY,
  form: "(employer-determined)",
  label: "North Dakota reservation-source wage exemption attestation",
  scope: { level: "region", region: "ND" },
  purpose: "exemption",
  citation:
    "North Dakota Office of State Tax Commissioner, Income Tax Withholding & "
    + "Information Returns Guideline, Section 1 p. 2 — wages paid to an enrolled "
    + "member of a federally recognized Indian tribe who lives on and performs "
    + "the services on an Indian reservation",
  summary:
    "Attests the employee's reservation-exemption eligibility and records the "
    + "reservation-source wages for the period. Only those wages are exempt; "
    + "off-reservation wages are withheld normally.",
  storage: "certificate_rows",
  fields: [
    { key: "enrolled_member", label: "Employee is an enrolled member of a federally recognized Indian tribe", kind: "flag", required: true, help: "Guideline eligibility condition 1." },
    { key: "lives_on_reservation", label: "Employee lives on an Indian reservation", kind: "flag", required: true, help: "Guideline eligibility condition 2." },
    {
      key: "reservation_source_wages",
      label: "Reservation-source wages this pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      required: true,
      help: "Wages for services the employee performed on the reservation this period (guideline condition 3). Off-reservation wages withhold normally.",
    },
  ],
};

/** North Dakota Form NDW-R for qualifying Minnesota and Montana residents. */
export const ND_NDWR_CERTIFICATE: PayrollCertificate = {
  key: "us_nd_ndwr",
  form: "NDW-R",
  label: "Reciprocity Exemption for Qualifying Minnesota and Montana Residents Working in North Dakota",
  scope: { level: "region", region: "ND" },
  purpose: "non_residence",
  validity: { kind: "calendar_year_end" },
  citation: "North Dakota Form NDW-R (SFN 28729, 2023); N.D.C.C. § 57-38-60",
  summary: "Annual certificate for qualifying Minnesota or Montana residents working in North Dakota. The residence on the form must match the employee's verified residence; renew each calendar year.",
  storage: "certificate_rows",
  fields: [{
    key: "qualifying_residence",
    label: "Employee's qualifying permanent residence",
    kind: "choice",
    required: true,
    choices: [
      { value: "MN", label: "Minnesota" },
      { value: "MT", label: "Montana" },
    ],
    help: "Match the NDW-R residence claim to the employee's verified permanent residence.",
  }],
};

export const ND_REGION: PayrollRegionWithholding = {
  region: "ND",
  label: "North Dakota income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // The ND Withholding Guideline requires a North Dakota-based employer to
  // withhold from a resident working in another state, except when required
  // to withhold the other state's tax — a conditional waiver, not a credit.
  residentWithholding: "required",
  residentWithholdingImplemented: true,
  residentWithholdingMethod: { kind: "waive_when_work_region_withheld" },
  certificateKey: "us_nd_w4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "North Dakota Office of State Tax Commissioner, Income Tax Withholding "
    + "Rates and Instructions for wages paid in 2026; federal Form W-4",
};
