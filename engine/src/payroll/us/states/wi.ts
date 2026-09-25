/**
 * Wisconsin income tax withholding — Publication W-166 ALTERNATE METHOD
 * (the computer formula).
 *
 * Source (fetched from revenue.wi.gov, not memory):
 *   Publication W-166, Withholding Tax Guide — January 2026
 *     (https://www.revenue.wi.gov/DOR%20Publications/pb166.pdf),
 *     Alternate Method of Withholding Wisconsin Income Tax pp. 25–26 and
 *     its three worked examples; reciprocity p. 8; Form WT-4 rules pp. 7–8.
 *     Laws interpreted as of January 15, 2026. The January 2026 edition
 *     reprints the formula that has been effective for withholding periods
 *     beginning on or after January 1, 2022 (Withholding Tax Update WTU-001,
 *     October 2025: no rate change planned).
 *   Form WT-4, Employee's Wisconsin Withholding Exemption Certificate
 *     (W-204, R. 8-23).
 *   Form W-220, Nonresident Employee's Withholding Reciprocity Declaration
 *     (R. 7-20).
 *
 * The formula annualizes, subtracts a phased-out standard deduction that
 * depends on Single vs Married and on the annual gross itself, subtracts
 * $400 per WT-4 exemption, applies the four-band rate schedule, and
 * de-annualizes. The three worked examples are the goldens.
 *
 * Supplemental wages paid with regular wages are aggregated (W-166 p. 25).
 * The optional flat-percentage table on the same page is an employer
 * election for separately paid supplementals and is not applied here.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { PayrollError } from "../../error.ts";
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
  type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import { requireMilitarySpouseEligibility } from "./military-spouse.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/wi.ts";

export type WiSchedule = "single" | "married";

export interface WiDeduction {
  /** Full deduction when annual gross is below `phaseStart`. */
  full: string;
  /** Annual gross at which the phase-out begins (inclusive). */
  phaseStart: string;
  /** Annual gross at which the deduction is zero (inclusive). */
  phaseEnd: string;
  /** Printed percent of annual gross in excess of `phaseStart`. */
  phaseRate: string;
}

export interface WiBracket {
  /** Inclusive ceiling of this band; null is the open top. */
  notOver: string | null;
  /** Subtracted from annual net wage before the marginal rate. */
  ofExcessOver: string;
  rate: string;
  add: string;
}

export interface WiYearRates {
  year: number;
  status: "published" | "draft";
  exemption: string;
  deduction: Readonly<Record<WiSchedule, WiDeduction>>;
  brackets: readonly WiBracket[];
}

export const WI_RATES_2026: WiYearRates = {
  year: 2026,
  status: "published",
  exemption: "400",
  deduction: {
    single: {
      full: "6702",
      phaseStart: "17780",
      phaseEnd: "73630",
      phaseRate: pctToRate("12"),
    },
    married: {
      full: "9461",
      phaseStart: "25727",
      phaseEnd: "73032",
      phaseRate: pctToRate("20"),
    },
  },
  brackets: [
    { notOver: "12760", ofExcessOver: "0", rate: pctToRate("3.54"), add: "0" },
    { notOver: "25520", ofExcessOver: "12760", rate: pctToRate("4.65"), add: "451.70" },
    { notOver: "280950", ofExcessOver: "25520", rate: pctToRate("5.30"), add: "1045.04" },
    { notOver: null, ofExcessOver: "280950", rate: pctToRate("7.65"), add: "14582.83" },
  ],
};

const WI_EDITIONS_BY_YEAR: Record<number, WiYearRates> = {
  [WI_RATES_2026.year]: WI_RATES_2026,
};

export const WI_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Publication W-166 (January 2026), Alternate Method",
  effectiveFrom: "2026-01-01",
  citation:
    "Wisconsin Department of Revenue, Publication W-166, Withholding Tax Guide (January 2026), "
    + "Alternate Method of Withholding Wisconsin Income Tax (pp. 25–26); Form WT-4 (W-204 R. 8-23)",
  status: "published",
  region: "WI",
}];

export function wiRatesForPayDate(payDate: string): WiYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = WI_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(WI_WITHHOLDING, year);
  }
  return rates;
}

/**
 * WT-4 marital-status boxes onto the two deduction formulas.
 *
 * "Married, but withhold at higher Single rate" uses the Single deduction —
 * the box's own words. W-166 p. 8: if the employee fails to furnish a WT-4
 * (including after an expired complete-exemption claim), "the employee shall
 * be considered as claiming zero withholding exemptions." Marital status is
 * not named in that sentence; Single is the certificate's declared default
 * and the higher-tax box.
 */
export function wiScheduleFor(maritalStatus: string | null): WiSchedule {
  return maritalStatus === "married" ? "married" : "single";
}

/**
 * W-166 p. 25 step (b) — the phased-out standard deduction.
 *
 * Single: $6,702 below $17,780; $0 at $73,630 or more; otherwise
 *   $6,702 − 12% of (annual gross − $17,780).
 * Married: $9,461 below $25,727; $0 at $73,032 or more; otherwise
 *   $9,461 − 20% of (annual gross − $25,727).
 */
export function wiDeduction(annualGross: bigint, schedule: WiSchedule, rates: WiYearRates): bigint {
  const row = rates.deduction[schedule];
  if (annualGross < U(row.phaseStart)) return U(row.full);
  if (annualGross >= U(row.phaseEnd)) return 0n;
  return max0(U(row.full) - mulRateCents(annualGross - U(row.phaseStart), row.phaseRate));
}

/** W-166 p. 26 schedule of tax rates. */
export function wiAnnualTax(net: bigint, rates: WiYearRates): bigint {
  if (net <= 0n) return 0n;
  for (const band of rates.brackets) {
    if (band.notOver === null || net <= U(band.notOver)) {
      return U(band.add) + mulRateCents(net - U(band.ofExcessOver), band.rate);
    }
  }
  return 0n;
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = wiRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new PayrollError(`invalid pay periods per year for Wisconsin withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const militarySpouseCertificate = input.supportingCertificates?.us_wi_w221;
  if (militarySpouseCertificate?.onFile) {
    requireMilitarySpouseEligibility(militarySpouseCertificate, "Wisconsin", [
      { key: "employee_is_servicemember_spouse", description: "the employee is the spouse of a servicemember" },
      { key: "servicemember_present_under_orders", description: "the servicemember is present in Wisconsin in compliance with military orders" },
      { key: "spouse_present_solely_to_accompany", description: "the spouse is in Wisconsin solely to be with the servicemember" },
      { key: "spouse_resides_with_servicemember", description: "the spouse resides with the servicemember" },
      { key: "elected_domicile_not_wisconsin", description: "the spouse elected a qualifying domicile that is not Wisconsin" },
    ]);
    return {
      state: "WI", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
      statutoryTax: D(0n), additionalWithholding: D(0n),
      factors: { WI_NONRESIDENT_MILITARY_SPOUSE_EXEMPT: "1" },
    };
  }

  if (certificateFlag(input.certificate, "exempt")) {
    return {
      state: "WI", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
      statutoryTax: D(0n), additionalWithholding: D(0n),
      factors: { WI_EXEMPT: "1" },
    };
  }

  const withholdingAgreement = input.supportingCertificates?.us_wi_wt4a;
  if (withholdingAgreement?.onFile) {
    const agreedAmount = U(certificateAmount(withholdingAgreement, "agreed_per_period") ?? "0");
    return {
      state: "WI", year: rates.year, tax: D(agreedAmount), taxSupplemental: D(0n),
      factors: { WI_WT4A_AGREED_WITHHOLDING: D(agreedAmount) },
    };
  }

  // W-166 p. 8: wages are not subject to withholding while the nonresident
  // expects under $1,500 of Wisconsin wages for the year and the running
  // total (year-to-date plus this check) has not reached $1,500. The
  // crossing check withholds in full on the whole current amount, and later
  // checks price period-only. Both figures are assignment evidence the
  // formula cannot infer, so a nonresident calculation without them refuses
  // by name; residents never reach this branch.
  if (input.basis === "nonresident") {
    const expected = input.nonresidentExpectedAnnualWages;
    const ytd = input.nonresidentYtdWages;
    if (expected == null || ytd == null) {
      throw new PayrollError(
        "Wisconsin withholding for a nonresident needs the expected annual Wisconsin wages "
        + "and the year-to-date Wisconsin wages (W-166: under $1,500 expected is exempt until "
        + "the running total reaches $1,500). Record both figures before calculating — refused by name",
      );
    }
    const current = U(input.wages) + U(input.supplemental ?? "0");
    if (U(expected) < U("1500") && U(ytd) + current < U("1500")) {
      return {
        state: "WI", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
        factors: { WI_NONRESIDENT_THRESHOLD_EXEMPT: "1", WI_NONRESIDENT_WAGES: D(current) },
      };
    }
  }

  const schedule = wiScheduleFor(certificateChoice(input.certificate, "marital_status"));
  factors.WI_SCHEDULE = schedule;
  const exemptions = certificateCount(input.certificate, "exemptions") ?? 0;

  // W-166 §3.I(4)(b): a nonresident whose annual Wisconsin earnings the
  // employer can reasonably expect to stay under $1,500 is not withheld from.
  // The estimate is the employer's asserted expectation when supplied, else
  // this period's Wisconsin wages annualized — a level-wages read the catch-up
  // below corrects the moment the year proves it wrong. Residents never take
  // this exception: the section governs nonresidents only.
  let catchUpBase = 0n;
  if (input.basis === "nonresident") {
    const periodWiWages = U(input.wages) + U(input.supplemental ?? "0");
    const asserted = input.wiExpectedAnnualWages;
    const expected = asserted === undefined ? periodWiWages * BigInt(P) : U(asserted);
    if (expected < 0n) {
      throw new PayrollError(
        `invalid expected Wisconsin annual wages for the under-$1,500 nonresident rule: ${asserted}`,
      );
    }
    trace("WI_EXPECTED_ANNUAL_WAGES", expected);
    if (expected < U("1500")) {
      return {
        state: "WI", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
        statutoryTax: D(0n), additionalWithholding: D(0n),
        factors: { ...factors, WI_UNDER_1500_EXEMPT: "1" },
      };
    }
    // The estimate crossed $1,500: "the employer must withhold from wages paid
    // thereafter, sufficient amounts to offset amounts not withheld from wages
    // previously paid." The previously-paid base is authoritative actuals —
    // the ledger's year-to-date Wisconsin wages — and only a base with NO
    // withholding against it can be previously-unwithheld, so any positive
    // prior tax means earlier periods already withheld and no catch-up applies.
    const priorBase = U(input.ytd?.wages ?? "0") + U(input.ytd?.supplemental ?? "0");
    if (priorBase > 0n && U(input.ytd?.tax ?? "0") === 0n) {
      catchUpBase = priorBase;
      trace("WI_CATCHUP_BASE", catchUpBase);
    }
  }

  // W-166 p. 25: paid with regular wages, treat as one payment.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualGross = wages * BigInt(P);
  trace("WI_ANNUAL_GROSS", annualGross);

  const deduction = wiDeduction(annualGross, schedule, rates);
  trace("WI_DEDUCTION", deduction);

  const exemption = U(rates.exemption) * BigInt(Math.max(exemptions, 0));
  trace("WI_EXEMPTION", exemption);

  const net = max0(annualGross - deduction - exemption);
  trace("WI_ANNUAL_NET", net);

  const annualTax = wiAnnualTax(net, rates);
  trace("WI_ANNUAL_TAX", annualTax);

  const periodTax = divIntCents(annualTax, P);
  // Catch-up prices the previously-unwithheld base through the same annual
  // method (the aggregate-method doctrine: tax on the cumulative annual-scale
  // base less tax on this period's annual scale), added to this period whole
  // rather than spread — the statute demands the offset, not a schedule.
  let catchUp = 0n;
  if (catchUpBase > 0n) {
    const cumulativeGross = annualGross + catchUpBase;
    const cumulativeDeduction = wiDeduction(cumulativeGross, schedule, rates);
    const cumulativeTax = wiAnnualTax(max0(cumulativeGross - cumulativeDeduction - exemption), rates);
    catchUp = max0(cumulativeTax - annualTax);
    if (catchUp > 0n) trace("WI_CATCHUP", catchUp);
  }
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + catchUp + extra;
  trace("WI_WITHHELD", total);

  return {
    state: "WI",
    year: rates.year,
    tax: D(total),
    statutoryTax: D(periodTax + catchUp),
    additionalWithholding: D(extra),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys above. Terms are the W-166 Alternate Method's own — see the module
 * header.
 */
export const WI_FACTOR_LABELS: Readonly<Record<string, string>> = {
  WI_NONRESIDENT_MILITARY_SPOUSE_EXEMPT: "Wisconsin qualifying military-spouse wages exempt from withholding",
  WI_NONRESIDENT_THRESHOLD_EXEMPT: "Wisconsin nonresident wages exempt under the $1,500 threshold",
  WI_NONRESIDENT_WAGES: "Wisconsin nonresident wages this period",
  WI_EXEMPT: "Exempt from Wisconsin withholding",
  WI_WT4A_AGREED_WITHHOLDING: "Wisconsin WT-4A agreed withholding per period",
  WI_SCHEDULE: "Wisconsin schedule (marital status)",
  WI_ANNUAL_GROSS: "Wisconsin annual gross",
  WI_DEDUCTION: "Wisconsin deduction",
  WI_EXEMPTION: "Wisconsin exemption",
  WI_ANNUAL_NET: "Wisconsin annual net income",
  WI_ANNUAL_TAX: "Wisconsin tax (annual)",
  WI_WITHHELD: "Wisconsin tax withheld this period",
  WI_EXPECTED_ANNUAL_WAGES: "Wisconsin expected annual earnings (§3.I(4)(b) estimate)",
  WI_UNDER_1500_EXEMPT: "Wisconsin nonresident under-$1,500 expectation, no withholding",
  WI_CATCHUP_BASE: "Wisconsin wages previously paid without withholding",
  WI_CATCHUP: "Wisconsin catch-up withholding on the previously-unwithheld base",
};

export const WI_WITHHOLDING: UsStateWithholdingEngine = {
  state: "WI",
  label: "Wisconsin income tax",
  certificateKey: "us_wi_wt4",
  ratesModule: RATES_MODULE,
  editions: WI_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  supportingCertificateKeys: ["us_wi_w221", "us_wi_wt4a"],
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Wisconsin withholding certificate and region declaration.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's declaration. Shape matches
 * IL_W4 / NC_NC4 / NC_REGION.
 *
 * Sources: Form WT-4 (W-204 R. 8-23); Publication W-166 (January 2026);
 * Form W-220 (R. 7-20); Publication 121 Reciprocity (January 2026).
 */
/** Form WT-4 — Employee's Wisconsin Withholding Exemption Certificate (R. 8-23). */
export const WI_CERTIFICATE: PayrollCertificate = {
  key: "us_wi_wt4",
  form: "WT-4",
  label: "Employee's Wisconsin Withholding Exemption Certificate",
  scope: { level: "region", region: "WI" },
  purpose: "withholding",
  // W-166 p. 8: a complete-exemption WT-4 must be renewed by April 30.
  validity: {
    kind: "following_year_date",
    monthDay: "04-30",
    appliesWhen: { field: "exempt", values: ["true"] },
  },
  citation:
    "Wisconsin Form WT-4 (W-204 R. 8-23); Publication W-166, Withholding Tax Guide (January 2026), p. 8, https://www.revenue.wi.gov/DOR%20Publications/pb166.pdf",
  summary:
    "Sets Wisconsin withholding exemptions and marital status. W-166: if the employee fails to "
    + "furnish a WT-4, \"the employee shall be considered as claiming zero withholding exemptions.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "marital_status", label: "Withholding status", kind: "choice",
      choices: [
        { value: "single", label: "Single (or married but legally separated)" },
        { value: "married", label: "Married" },
        {
          value: "married_higher_single",
          label: "Married, but withhold at higher Single rate",
          help: "Uses the Single deduction formula.",
        },
      ],
      default: "single", required: true,
      help: "W-166 names zero exemptions as the no-certificate rule and does not name a marital "
        + "status; Single is the form's first box and the higher-tax default.",
    },
    {
      key: "exemptions", label: "Line 1(d) — Total withholding exemptions", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Lines 1(a)–(c) added: self, spouse, dependents. Worth $400 a year each. Default "
        + "zero: W-166 p. 8.",
    },
    {
      key: "additional_per_period",
      label: "Line 2 — Additional amount per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Only if the employer agrees. Added after the formula.",
    },
    {
      key: "exempt", label: "Line 3 — Complete exemption from withholding", kind: "flag",
      help: "No Wisconsin liability last year and none expected this year. Expires April 30 of "
        + "the next year unless a new WT-4 is filed. Federal Form W-4 cannot claim this. "
        + "Reciprocity is Form W-220, not this line.",
    },
  ],
};

/** Form WT-4A — Employee Withholding Agreement (2026 Form W-234, R. 11-25). */
export const WI_WT4A: PayrollCertificate = {
  key: "us_wi_wt4a",
  form: "WT-4A",
  label: "Wisconsin Employee Withholding Agreement",
  scope: { level: "region", region: "WI" },
  purpose: "withholding",
  validity: { kind: "following_year_date", monthDay: "04-30" },
  citation:
    "Wisconsin Form WT-4A, Employee Withholding Agreement (W-234 R. 11-25), lines 1–3 and employer instructions; "
    + "Publication W-166 (January 2026), §3.B p. 8, https://www.revenue.wi.gov/TaxForms2017through2019/w-234f.pdf",
  summary:
    "Records an employee and employer agreement to withhold a lesser per-pay-period amount than the Wisconsin table, "
    + "when the employee has claimed the maximum WT-4 exemptions and still expects overwithholding.",
  storage: "certificate_rows",
  fields: [{
    key: "agreed_per_period",
    label: "Line 3 — Amount to be withheld each payroll period",
    kind: "amount", decimals: 4, min: "0", required: true,
    help: "Enter the amount on line 3 of the filed WT-4A agreement. This replaces Wisconsin table withholding.",
  }],
};

/**
 * Form W-220 — Nonresident Employee's Withholding Reciprocity Declaration (R. 7-20).
 *
 * Wisconsin's agreements are with Illinois, Indiana, Kentucky, and Michigan.
 * "Written verification is required to relieve the employer from withholding
 * Wisconsin income taxes" (W-166 p. 8). W-220 "may be used for this purpose."
 */
export const WI_W220: PayrollCertificate = {
  key: "us_wi_w220",
  form: "W-220",
  label: "Nonresident Employee's Withholding Reciprocity Declaration (Wisconsin)",
  scope: { level: "region", region: "WI" },
  purpose: "non_residence",
  citation:
    "Wisconsin Form W-220 (R. 7-20); Publication W-166 (January 2026) p. 8; Publication 121 "
    + "Reciprocity (January 2026)",
  summary:
    "Claims exemption from Wisconsin withholding under a reciprocal agreement. Residence in "
    + "Illinois, Indiana, Kentucky or Michigan is not enough on its own: written verification "
    + "is required.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "I declare that while working in Wisconsin I am a legal resident of",
      kind: "choice",
      choices: [
        { value: "IL", label: "Illinois" },
        { value: "IN", label: "Indiana" },
        { value: "KY", label: "Kentucky" },
        { value: "MI", label: "Michigan" },
      ],
      required: true,
      help: "Wisconsin has reciprocal agreements with exactly these four states.",
    },
  ],
};

/** Form W-221 — Nonresident Military Spouse Withholding Exemption. */
export const WI_W221: PayrollCertificate = {
  key: "us_wi_w221",
  form: "W-221",
  label: "Nonresident Military Spouse Withholding Exemption (Wisconsin)",
  scope: { level: "region", region: "WI" },
  purpose: "exemption",
  citation:
    "Wisconsin Form W-221 (R. 11/2024); Wisconsin DOR Nonresident Military Spouse Withholding "
    + "Exemption FAQ (Oct. 9, 2025); 50 U.S.C. 4001(a)(3)",
  summary:
    "The W-221 election remains effective until revoked. It exempts the employee's Wisconsin "
    + "service income only while every statutory military-spouse condition remains true.",
  storage: "certificate_rows",
  fields: [
    {
      key: "employee_is_servicemember_spouse",
      label: "Employee is the spouse of a servicemember",
      kind: "flag", required: true,
      help: "W-221 Part II eligibility certification.",
    },
    {
      key: "servicemember_present_under_orders",
      label: "Servicemember is present in Wisconsin in compliance with military orders",
      kind: "flag", required: true,
      help: "W-221 Part II eligibility certification.",
    },
    {
      key: "spouse_present_solely_to_accompany",
      label: "Spouse is in Wisconsin solely to be with the servicemember",
      kind: "flag", required: true,
      help: "W-221 Part II eligibility certification.",
    },
    {
      key: "spouse_resides_with_servicemember",
      label: "Spouse resides with the servicemember",
      kind: "flag", required: true,
      help: "Wisconsin DOR's W-221 eligibility guidance requires that the spouse and servicemember reside together.",
    },
    {
      key: "elected_domicile_not_wisconsin",
      label: "Spouse elected a qualifying domicile that is not Wisconsin",
      kind: "flag", required: true,
      help:
        "W-221 election may use the servicemember's domicile, the spouse's domicile, or the "
        + "servicemember's permanent duty station; the elected domicile cannot be Wisconsin.",
    },
  ],
};

export const WI_REGION: PayrollRegionWithholding = {
  region: "WI",
  label: "Wisconsin income tax",
  implemented: true,
  // W-166 p. 8 + §3.I(4)(b): wages paid to nonresidents for services performed
  // in Wisconsin are subject to withholding unless an exception (reciprocity,
  // interstate carrier, military spouse) applies — or the employer reasonably
  // expects annual Wisconsin earnings under $1,500, in which case compute()
  // exempts and, once the estimate crosses $1,500, withholds from later wages
  // with catch-up on the previously-unwithheld base.
  taxesNonresidentWages: true,
  // W-166 p. 7: resident wages are subject to Wisconsin withholding; the
  // special Minnesota arrangement is an eligibility waiver in the engine.
  residentWithholding: "required",
  residentWithholdingImplemented: true,
  residentWithholdingMethod: { kind: "waive_when_work_region_withheld", regions: ["MN"] },
  certificateKey: "us_wi_wt4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Wisconsin Department of Revenue, Publication W-166, Withholding Tax Guide (January 2026), "
    + "Alternate Method (pp. 25–26); Form WT-4 (W-204 R. 8-23)",
};
