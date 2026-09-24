/**
 * District of Columbia income-tax withholding — FR-230 percentage of wages
 * paid method, with the schedule and allowance substituted by OTR Tax Notice
 * 2022-08.
 *
 * Sources (every figure fetched, never from memory):
 *   FR-230, "District of Columbia Income Tax Withholding Instructions and
 *     Tables", Withholding Allowances for the Year 2018 (FR-230 Rev. 11/17),
 *     https://otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2018%20FR-230_12.13.17.pdf
 *     — the percentage method's three steps (p. 9: multiply the Table 1
 *       per-period allowance by the allowances claimed; subtract from wages;
 *       look the remainder up in the per-period percentage table), the
 *       Table 1 allowance figures, the per-period percentage tables
 *       (pp. 10–11), the D-4/D-4A certificate rules (pp. 2–3), the wages
 *       definition covering bonuses and commissions (p. 2), and the
 *       "standard deduction will not be used in the withholding calculation"
 *       rule (p. 5).
 *   OTR Tax Notice 2022-08, "District of Columbia Withholding for Tax Year
 *     2022" (October 17, 2022),
 *     https://otr.cfo.dc.gov/release/otr-tax-notice-2022-08-district-columbia-withholding-tax-year-2022
 *     (attachment PDF fetched from the same page) — TCJA suspended personal
 *     exemptions so OTR can no longer produce withholding tables; employers
 *     use "the new 2022 tax rate schedule" and "the federal allowance amount
 *     for tax year 2022". No later withholding notice exists: the OTR Tax
 *     Notices and Guidance listing (fetched September 2026) carries no
 *     withholding notice after 2022-08, and the withholding-instructions page
 *     still names the 2018 FR-230 as the latest booklet.
 *   OTR "DC Individual and Fiduciary Income Tax Rates" (fetched September
 *     2026), https://otr.cfo.dc.gov/page/dc-individual-and-fiduciary-income-tax-rates
 *     — the schedule for tax years beginning after 12/31/2021, still the
 *     published schedule: 4% / 6% / 6.5% / 8.5% / 9.25% / 9.75% / 10.75%
 *     with the cumulative amounts transcribed below (each reproduces from
 *     the prior brackets — asserted in conformance-dc.test.ts).
 *   IRS Publication 15-T (2026), Worksheet 1A line 1k (fetched from
 *     irs.gov/publications/p15t, September 2026) — "Multiply line 1j by
 *     $4,300": the federal allowance amount for 2026. It agrees with the
 *     pack's own Pub 15-T transcription (RATES_2026.allowanceAmount), which
 *     this module must NOT import — rates.ts builds on states/editions.ts,
 *     so a state engine importing the federal rates would close a module
 *     cycle. The figure is carried here with its own citation instead, and
 *     the conformance test asserts the two agree.
 *   DC Code § 47-1812.08(b)(1) (fetched from code.dccouncil.gov, September
 *     2026) — "Every employer making payment of wages ... shall deduct and
 *     withhold", the universality behind the region declaration.
 *
 * The method, assembled from those sources:
 *
 *   allowance(this period) = round($4,300 ÷ D) × allowances claimed
 *   taxable = max(0, period wages − allowance)
 *   tax = scaled-schedule(taxable)
 *
 * where D is the pay periods in the year — except daily, whose tables FR-230
 * prints on a 365-day divisor (Table 1 daily allowance $11.37 = $4,150 ÷ 365;
 * daily table first threshold $27.40 = $10,000 ÷ 365), so D = 365 for both
 * daily frequencies (260 and 365).
 *
 * The scaling rule (annual ÷ D, half-up to the cent) is not invented: every
 * figure in FR-230's 2018 printed tables is the 2018 annual figure scaled
 * exactly that way (weekly $79.81 = $4,150 ÷ 52; weekly second-bracket base
 * $7.69 = $400 ÷ 52; daily first threshold $27.40 = $10,000 ÷ 365), and the
 * conformance test re-derives a sample of the printed 2018 figures through
 * the engine's own scaler. What 2022-08 changes is only the INPUTS — the
 * schedule and the allowance — not the method.
 *
 * Two things FR-230's method does NOT have, stated here so nobody adds them:
 *
 *   - No standard deduction. FR-230 p. 5 says so in a section heading: "The
 *     standard deduction will not be used in the withholding calculation."
 *   - No filing-status dimension. The booklet prints two percentage
 *     schedules — single-or-separate and joint-or-head — and they are
 *     numerically IDENTICAL (the District's tax schedule is status-blind, as
 *     the OTR rates page confirms with its single schedule). The engine
 *     carries one schedule and reads no filing status.
 *
 * Deliberately out of scope, each with its reason:
 *
 *   - The wage-BRACKET method. FR-230 offers it as an employer election, and
 *     its 2018 tables are stale in exactly the way the percentage tables
 *     were. There is no 2026 bracket table to transcribe, and manufacturing
 *     one by scaling would be publishing a table OTR never printed. The
 *     percentage method is the one written for payroll systems.
 *   - Retirement lump-sum distributions at the highest rate (10.75% per
 *     Notice 2022-08; FR-230 p. 2). That is a PAYOR rule on distributions,
 *     and UsStateWithholdingInput carries no distribution field — only
 *     wages and supplemental wages (bonus, commission, severance), which
 *     FR-230's wages definition covers as ordinary wages.
 *   - A D-4A nonresidence certificate declaration. D-4A relief runs through
 *     reciprocity agreement rows (workRegion = DC), and no fetched DC-side
 *     source names that agreement or its mechanism — see the region note
 *     below. A certificate nothing reads would be storage without a reader.
 *   - An additional-withholding line. FR-230 names none and the D-4 itself
 *     is unposted ("currently under review" per OTR's withholding-tax-forms
 *     page, fetched September 2026), so there is no citable line to model.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { PayrollError } from "../../error.ts";
import { D, divIntCents, max0, mulInt, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateCount, certificateFlag, type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
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

const RATES_MODULE = "engine/src/payroll/us/states/dc.ts";

/** Every period FR-230 prints percentage-method tables for (Table 1 + pp. 10–11). */
const DC_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "annual", "daily",
];

export interface DcBracket {
  /** Annual "Over" threshold, as the OTR rates page prints it. */
  over: string;
  /** Annual "but not over" threshold, or null for the top bracket. */
  notOver: string | null;
  /** Annual cumulative base ("The tax is: $X, plus ..."). */
  base: string;
  /** Marginal rate as the page prints it ("4%", "9.75%"). */
  rate: string;
}

export interface DcYearRates {
  year: number;
  status: "published" | "draft";
  /**
   * The federal allowance amount for the tax year (IRS Pub 15-T Worksheet 1A
   * line 1k): $4,300 for 2026. Values ONE D-4 withholding allowance for the
   * whole year; the per-period figure is derived by scaling.
   */
  allowanceAnnual: string;
  /**
   * The District's individual income tax schedule for the year, annual
   * figures exactly as OTR prints them.
   */
  brackets: readonly DcBracket[];
}

/**
 * 2026 — OTR "DC Individual and Fiduciary Income Tax Rates", schedule for
 * tax years beginning after 12/31/2021 (still the published schedule when
 * fetched, September 2026), with the allowance from IRS Pub 15-T (2026)
 * line 1k via OTR Tax Notice 2022-08.
 *
 * Cumulative-amount check (asserted in conformance-dc.test.ts):
 *   4% × 10,000 = 400;
 *   400 + 6% × 30,000 = 2,200;
 *   2,200 + 6.5% × 20,000 = 3,500;
 *   3,500 + 8.5% × 190,000 = 19,650;
 *   19,650 + 9.25% × 250,000 = 42,775;
 *   42,775 + 9.75% × 500,000 = 91,525.
 */
export const DC_RATES_2026: DcYearRates = {
  year: 2026,
  status: "published",
  allowanceAnnual: "4300",
  brackets: [
    { over: "0", notOver: "10000", base: "0", rate: pctToRate("4") },
    { over: "10000", notOver: "40000", base: "400", rate: pctToRate("6") },
    { over: "40000", notOver: "60000", base: "2200", rate: pctToRate("6.5") },
    { over: "60000", notOver: "250000", base: "3500", rate: pctToRate("8.5") },
    { over: "250000", notOver: "500000", base: "19650", rate: pctToRate("9.25") },
    { over: "500000", notOver: "1000000", base: "42775", rate: pctToRate("9.75") },
    { over: "1000000", notOver: null, base: "91525", rate: pctToRate("10.75") },
  ],
};

const DC_EDITIONS_BY_YEAR: Record<number, DcYearRates> = {
  [DC_RATES_2026.year]: DC_RATES_2026,
};

export const DC_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "OTR Tax Notice 2022-08 method on the post-2021 rate schedule",
  effectiveFrom: "2026-01-01",
  citation:
    "FR-230 (Rev. 11/17) percentage of wages paid method (p. 9); OTR Tax Notice 2022-08 "
    + "(10/17/2022) substituting the current rate schedule and the federal allowance amount; OTR "
    + "\"DC Individual and Fiduciary Income Tax Rates\" schedule for tax years beginning after "
    + "12/31/2021; IRS Publication 15-T (2026), Worksheet 1A line 1k ($4,300 per allowance)",
  status: "published",
  region: "DC",
}];

export function dcRatesForPayDate(payDate: string): DcYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = DC_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(DC_WITHHOLDING, year);
  }
  return rates;
}

/**
 * The divisor FR-230's tables are scaled on: the pay periods in the year,
 * except daily, which the booklet prints on a 365-day divisor (Table 1 daily
 * allowance and the daily percentage table alike). A 260-period payroll uses
 * the same per-day table — there is no second daily table to transcribe.
 */
export function dcDivisorForPeriod(period: UsStatePayPeriod, periodsPerYear: number): number {
  return period === "daily" ? 365 : periodsPerYear;
}

/** One D-4 withholding allowance for the period, half-up to the cent. */
export function dcAllowancePerPeriod(
  rates: DcYearRates,
  period: UsStatePayPeriod,
  periodsPerYear: number,
): bigint {
  return divIntCents(U(rates.allowanceAnnual), dcDivisorForPeriod(period, periodsPerYear));
}

export interface DcScaledBracket {
  over: bigint;
  notOver: bigint | null;
  base: bigint;
  rate: string;
}

/**
 * The annual schedule scaled to the period with FR-230's own rounding
 * (annual ÷ divisor, half-up to the cent) — the rule every figure in the
 * booklet's printed tables follows. `rates` is a parameter (not the 2026
 * constant) so the conformance test can run the 2018 annual figures through
 * it and compare against the 2018 printed tables.
 */
export function dcScaledBrackets(
  rates: DcYearRates,
  period: UsStatePayPeriod,
  periodsPerYear: number,
): DcScaledBracket[] {
  const divisor = dcDivisorForPeriod(period, periodsPerYear);
  return rates.brackets.map((bracket) => ({
    over: divIntCents(U(bracket.over), divisor),
    notOver: bracket.notOver === null ? null : divIntCents(U(bracket.notOver), divisor),
    base: divIntCents(U(bracket.base), divisor),
    rate: bracket.rate,
  }));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = dcRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new PayrollError(`invalid pay periods per year for District of Columbia withholding: ${P}`);
  }
  // FR-230 prints percentage-method tables for the eight DC_PERIODS (Table 1
  // plus the pp. 10–11 tables). Any other P has no published table to look
  // up, and a scaled one would not be the published table.
  const period = payPeriodFor(P);
  if (period === null || !DC_PERIODS.includes(period)) {
    refuseUnprintedPeriod(DC_WITHHOLDING, P);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  // FR-230 p. 5: a servicemember spouse whose wages are exempt under federal
  // law "may file a D-4 with their employer to claim exemption from
  // withholding". That is the only D-4 exemption the booklet names.
  if (certificateFlag(input.certificate, "exempt")) {
    trace("DC_EXEMPT", 1n);
    return { state: "DC", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // FR-230 p. 2: wages cover "salaries, fees, bonuses and commissions" —
  // supplemental pay is ordinary wages here. The booklet prints no
  // supplemental-wage rule, so there is no separate supplemental computation
  // to report, and inventing a flat rate citing a rule that does not exist
  // would be worse than none.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  trace("DC_WAGES", wages);

  // FR-230 p. 9 steps 1–2: the Table 1 per-period allowance times the D-4
  // allowances, subtracted from wages. FR-230 requires a D-4 of every DC
  // resident employee but states no no-certificate rule, so a missing answer
  // defaults to zero allowances — withholding on the full wage, the
  // fail-closed choice (the Illinois precedent, not an OTR rule).
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const perAllowance = divIntCents(
    U(rates.allowanceAnnual), dcDivisorForPeriod(period, P),
  );
  trace("DC_ALLOWANCE_PER_PERIOD", perAllowance);
  const allowance = mulInt(perAllowance, allowances);
  trace("DC_ALLOWANCE", allowance);
  const taxable = max0(wages - allowance);
  trace("DC_TAXABLE", taxable);

  // Step 3: the percentage-table lookup on the scaled schedule. Negative
  // (wages − allowance) is floored at zero above: the tables print no
  // negative and a negative would refund tax never withheld.
  const scaled = dcScaledBrackets(rates, period, P);
  const bracket = scaled.find((candidate) =>
    candidate.notOver === null || taxable <= candidate.notOver,
  );
  if (!bracket) {
    // Unreachable: the top bracket has no ceiling, so every taxable amount
    // matches. The throw keeps the lookup total instead of trusting that.
    throw new PayrollError(
      `no District of Columbia bracket covers ${D(taxable)} for a ${period} payroll`,
    );
  }
  const tax = bracket.base + mulRateCents(taxable - bracket.over, bracket.rate);
  trace("DC_TAX", tax);
  trace("DC_WITHHELD", tax);

  return {
    state: "DC",
    year: rates.year,
    tax: D(tax),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above. Terms are FR-230's own — see the module header.
 */
export const DC_FACTOR_LABELS: Readonly<Record<string, string>> = {
  DC_EXEMPT: "Exempt from District of Columbia withholding",
  DC_WAGES: "District of Columbia wages this period",
  DC_ALLOWANCE_PER_PERIOD: "District of Columbia allowance value this period",
  DC_ALLOWANCE: "District of Columbia allowance this period",
  DC_TAXABLE: "District of Columbia taxable wages",
  DC_TAX: "District of Columbia tax this period",
  DC_WITHHELD: "District of Columbia tax withheld this period",
};

export const DC_WITHHOLDING: UsStateWithholdingEngine = {
  state: "DC",
  label: "District of Columbia income tax",
  certificateKey: "us_dc_d4",
  ratesModule: RATES_MODULE,
  editions: DC_TAX_YEAR_EDITIONS,
  // FR-230 Table 1 plus the pp. 10–11 percentage tables: weekly, biweekly,
  // semimonthly, monthly, quarterly, semiannual, annual, and daily.
  printedPeriods: DC_PERIODS,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * District of Columbia withholding declarations — Form D-4 and the region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form D-4, DC Withholding Allowance Certificate. */
export const DC_CERTIFICATE: PayrollCertificate = {
  key: "us_dc_d4",
  form: "D-4",
  label: "DC Withholding Allowance Certificate",
  scope: { level: "region", region: "DC" },
  purpose: "withholding",
  citation:
    "FR-230 (Rev. 11/17) pp. 2–3 (D-4/D-4A); OTR Tax Notice 2022-08 (10/17/2022); "
    + "IRS Publication 15-T (2026), Worksheet 1A line 1k",
  summary:
    "Sets the number of D-4 withholding allowances. FR-230 requires a D-4 of every DC "
    + "resident employee on hire. Each allowance is worth the federal allowance amount "
    + "($4,300 in 2026) under Notice 2022-08; the standard deduction is not used in the "
    + "withholding calculation (FR-230 p. 5).",
  storage: "certificate_rows",
  fields: [
    {
      key: "allowances",
      label: "D-4 — Withholding allowances claimed",
      kind: "count",
      min: "0", max: "99", default: "0",
      help:
        "Number of withholding allowances on the D-4, each worth $4,300 a year in 2026 "
        + "(Notice 2022-08 + Pub 15-T line 1k). Default zero: FR-230 requires a D-4 but states "
        + "no no-certificate rule, so without one the engine withholds on the full wage rather "
        + "than assuming allowances — the fail-closed choice, not an OTR rule.",
    },
    {
      key: "exempt",
      label: "Exempt from DC withholding",
      kind: "flag",
      help:
        "FR-230 p. 5: a servicemember spouse whose wages are exempt from District income tax "
        + "under federal law may file a D-4 claiming exemption from withholding. The only D-4 "
        + "exemption the booklet names.",
    },
  ],
};

export const DC_REGION: PayrollRegionWithholding = {
  region: "DC",
  label: "District of Columbia income tax",
  implemented: true,
  // DC Code § 47-1812.08(b)(1): "Every employer making payment of wages ...
  // shall deduct and withhold" — no resident-only carve-out — and FR-230 p. 3
  // puts the burden the other way: nonresidence must be CERTIFIED (D-4A) to
  // stop withholding, so withholding applies until that certificate exists.
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by FR-230 or Notice 2022-08: whether a DC resident's
  // wages earned entirely outside the District must be withheld on.
  // Declared unknown.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_dc_d4",
  // No sub-region levies: the District levies one income tax directly.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "FR-230 (Rev. 11/17); OTR Tax Notice 2022-08 (10/17/2022); OTR \"DC Individual and "
    + "Fiduciary Income Tax Rates\"; DC Code § 47-1812.08(b)(1)",
};
