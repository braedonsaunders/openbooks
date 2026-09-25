/**
 * US federal payroll withholding engine — Pub 15-T Worksheet 1A (percentage
 * method for automated payroll systems), FICA, FUTA, and configurable state
 * unemployment insurance.
 *
 * Faithful to the worksheet's line discipline: annualize, adjust per the
 * W-4 (2020-or-later Steps 2–4, or 2019-or-earlier allowances), look the
 * adjusted amount up in the printed annual schedule, de-annualize, credit,
 * add extra withholding. Amounts round half-up straight to the cent at each
 * worksheet line — all arithmetic is exact bigint via the shared decimal
 * helpers; no floats anywhere.
 *
 * Supplemental wages (bonuses, retro) use the Pub 15 §7 optional flat rate,
 * with the mandatory 37% rate on YTD supplemental wages past $1,000,000.
 * When the caller establishes that no FIT was withheld from regular wages in
 * the current or preceding year, the flat rate is unavailable and method 1b
 * applies (or the run refuses until the 1b basis exists).
 *
 * Out of scope in this wave (documented, not forgotten): state income tax
 * withholding (v1 covers the nine no-withholding states), nonresident-alien
 * additional amounts, and Form W-4P pension withholding.
 */
import { PayrollError } from "../error.ts";
import { bmin, D, divIntCents, max0, mulInt, mulRateCents, U } from "../canada/decimal";
import { type FilingStatus, ratesForPayDate, type WithholdingRow, type YearRates, US_STATES } from "./rates";

export interface Pub15TYtd {
  /** Social Security (OASDI) taxable wages before this period, this employer. */
  ssWages?: string;
  /** Medicare wages before this period, this employer (Additional Medicare trigger). */
  medicareWages?: string;
  /** FUTA wages before this period, this employer. */
  futaWages?: string;
  /** State unemployment wages before this period, this employer. */
  suiWages?: string;
  /** Supplemental wages before this period (mandatory 37% flat-rate trigger). */
  supplemental?: string;
}

export interface Pub15TInput {
  /** Pay date — selects the Pub 15-T edition (tax year). */
  payDate: string;
  /** P — pay periods in the year (52, 26, 24, 12, …). */
  periodsPerYear: number;

  /** Gross taxable periodic wages for this period (excludes supplemental). */
  wages: string;
  /** Supplemental wages this period (bonus, retro) — flat-rate method. */
  supplemental?: string;
  /**
   * Caller-established Pub. 15 §7 history: no FIT was withheld from the
   * employee's regular wages in the current or the preceding calendar year.
   * When true the optional flat rate is UNAVAILABLE and method 1b applies
   * (or the run refuses until the 1b basis below exists). Absent means the
   * caller has not established the history — the flat method still prices
   * the payment, and establishing this history is the caller's follow-up.
   */
  noRegularFitWithheld?: boolean;
  /**
   * Pub. 15 §7 method-1b basis, required when `noRegularFitWithheld` is
   * true: the most recent regular wage this supplement aggregates with,
   * and the FIT already withheld from that regular wage (excluding any
   * per-period additional amount, which is added separately every period).
   */
  supplementalRegularBasis?: {
    recentRegularWages: string;
    regularFitWithheld: string;
  };
  /** Social Security / Medicare wages this period. Defaults to wages + supplemental. */
  ficaWages?: string;
  /** FUTA (and SUI) wages this period. Defaults to wages + supplemental. */
  futaWages?: string;

  /** W-4 Step 1(c) filing status. */
  filingStatus: FilingStatus;
  /** W-4 Step 2 checkbox (multiple jobs / working spouse). */
  multipleJobs?: boolean;
  /** W-4 Step 3 — annual dependents and other credits. */
  dependentCredits?: string;
  /** W-4 Step 4(a) — annual other income. */
  otherIncomeAnnual?: string;
  /** W-4 Step 4(b) — annual deductions beyond the standard deduction. */
  deductionsAnnual?: string;
  /** W-4 Step 4(c) — extra withholding per period. */
  extraPerPeriod?: string;
  /**
   * 2019-or-earlier W-4 (Worksheet 1A lines 1j–1l): allowances × $4,300,
   * always the STANDARD schedule, married filing status maps to MFJ.
   * When set, Steps 2–4 fields are ignored (they exist only on 2020+ forms).
   */
  pre2020?: { allowances: number; married?: boolean };
  /** W-4 "Exempt" — no income tax withholding (FICA still applies). */
  fitExempt?: boolean;
  /**
   * Nonresident-alien wages require Pub. 15-T Table 1/2 adjustments and
   * student/apprentice exceptions that this engine has not transcribed.
   */
  nonresidentAlien?: boolean;

  /** Statutory exemptions (e.g. F-1 students, some family employment). */
  ficaExempt?: boolean;
  futaExempt?: boolean;
  suiExempt?: boolean;

  /**
   * Employer-configured NET FUTA rate for this state/account (the tenant
   * us_futa rate). Absent accrues the statutory 0.6% default. Never carries
   * a Schedule A credit reduction — that prices on the Form 940 year-end
   * true-up (futaScheduleATrueUp), never in a pay run.
   */
  futaEffectiveRate?: string;
  /**
   * State unemployment jurisdiction, retained for caller attribution context.
   * The per-period calculation ignores it (net rate everywhere); the year-end
   * true-up resolves regions from its own input.
   */
  futaRegion?: string;
  /**
   * Verified state work allocations, retained for caller attribution context.
   * The per-period calculation ignores them (net rate needs no attribution);
   * the year-end true-up prices from caller-attributed wages by region.
   */
  futaWorkAllocations?: readonly { region: string }[];
  /** Org-configured SUI for the employee's state; omit to skip SUTA. */
  sui?: { rate: string; wageBase: string };

  ytd?: Pub15TYtd;
}

export interface Pub15TResult {
  year: number;
  /** Federal income tax withheld this period (periodic + supplemental + extra). */
  fit: string;
  /** The supplemental-wage share of `fit` (flat-rate method). */
  fitSupplemental: string;
  /** Social Security — employee and employer (equal). */
  ss: string;
  ssEmployer: string;
  /** Medicare 1.45% — employee and employer (equal). */
  medicare: string;
  medicareEmployer: string;
  /** Additional Medicare 0.9% — employee only, over the YTD threshold. */
  additionalMedicare: string;
  /** Employer-only federal and state unemployment. */
  futa: string;
  suta: string;
  /** Every intermediate worksheet line, for the explainability trace. */
  factors: Record<string, string>;
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above. Step names are the IRS's own from Pub 15-T Worksheet 1A —
 * step 2g is the annual tentative withholding and step 2h the per-period
 * one, so TW is annual and TWP is per-period, and both are TAX, not wages.
 */
export const PUB15T_FACTOR_LABELS: Readonly<Record<string, string>> = {
  AAWA: "Adjusted annual wage amount (Worksheet 1A step 1)",
  TW: "Tentative withholding, annual (Worksheet 1A step 2g)",
  TWP: "Tentative withholding per pay period (Worksheet 1A step 2h)",
  FIT: "Federal income tax withheld this period",
  FIT_S: "Federal tax on supplemental wages (flat rate)",
  SS_TAXABLE: "Social Security taxable wages this period",
  SS: "Social Security tax (employee)",
  MED: "Medicare tax (employee)",
  // IRS Instructions for Form 941 (03/2026), line 5d:
  // https://www.irs.gov/instructions/i941
  MED2_TAXABLE: "Medicare wages subject to Additional Medicare Tax this period",
  MED2: "Additional Medicare tax (employee)",
  FUTA: "Federal unemployment tax (employer)",
  SUTA: "State unemployment tax (employer)",
};

const ZERO = 0n;

function opt(value: string | undefined): bigint {
  return value === undefined || value === "" ? ZERO : U(value);
}

function rowFor(schedule: WithholdingRow[], adjusted: bigint): WithholdingRow {
  let match = schedule[0]!;
  for (const row of schedule) {
    if (adjusted >= U(row.atLeast)) match = row;
    else break;
  }
  return match;
}

/** Wages already under the cap tax the incremental slice: min(wages, cap − ytd), floor 0. */
function cappedSlice(wages: bigint, cap: bigint, ytd: bigint): bigint {
  return max0(bmin(wages, cap - ytd));
}

/**
 * Form 940 Schedule A credit-reduction rates, keyed by the wage tax year.
 * The schedules list every state and DC; a missing state entry in a
 * transcribed year means the published table lists no credit reduction for
 * that jurisdiction.
 *
 * TIMING DOCTRINE. The reduction applies on the Form 940 year-end liability
 * (futaScheduleATrueUp below), never in a pay run: USDOL publishes the
 * year's credit-reduction states in November, so a per-period gate would
 * turn a year-end true-up into a gate blocking all US payroll for most of
 * the year. Per-period FUTA accrues at the net rate (the tenant us_futa
 * rate, 0.6% by default).
 *
 * Official sources:
 * - IRS 2024 Schedule A: https://www.irs.gov/pub/irs-prior/f940sa--2024.pdf
 * - IRS 2025 Schedule A (California 1.2% the only state; Connecticut and New
 *   York repaid before 2025-11-10): https://www.irs.gov/pub/irs-prior/f940sa--2025.pdf
 * The additional 940 liability is FUTA-taxable wages times the reduction;
 * the per-period net rate stays the ordinary 0.6%.
 */
const FUTA_CREDIT_REDUCTION: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  2024: { CA: "0.009", NY: "0.009" },
  2025: { CA: "0.012" },
};

/**
 * The Schedule A reduction for one jurisdiction in a transcribed year — the
 * year-end true-up's resolver. Refuses by name for a year whose Schedule A
 * is absent (compute the true-up once USDOL publishes it), and for a
 * jurisdiction outside the state table (territories price through the
 * tenant's configured net rate, never through this table).
 */
function creditReductionRate(year: number, region: string): string {
  const reductions = FUTA_CREDIT_REDUCTION[year];
  if (!reductions) {
    throw new PayrollError(
      `Form 940 year-end true-up refused: FUTA credit-reduction rates for ${year} are not transcribed from Schedule A `
      + "(USDOL publishes the year's credit-reduction states in November) — compute the true-up once the schedule "
      + "is transcribed — refused by name",
    );
  }
  if (!US_STATES.includes(region as (typeof US_STATES)[number])) {
    throw new PayrollError(
      `Form 940 year-end true-up refused: FUTA credit-reduction rate cannot be resolved for jurisdiction ${region} `
      + `in ${year}; configure a verified effective rate for the Schedule A jurisdiction — refused by name`,
    );
  }
  return reductions[region] ?? "0";
}

/**
 * Form 940 year-end true-up: the additional FUTA liability from Schedule A
 * credit reductions, summed state by state over the year's FUTA-taxable
 * wages. Pure and DB-free: wages arrive attributed by state UI jurisdiction
 * (multi-state attribution is the caller's job — per-period payroll never
 * attributes, it accrues the net rate). Refuses by name for a year whose
 * Schedule A is absent; never called from a pay run.
 */
export function futaScheduleATrueUp(
  year: number,
  futaTaxableWagesByRegion: Readonly<Record<string, string>>,
): string {
  let additional = ZERO;
  for (const [region, wages] of Object.entries(futaTaxableWagesByRegion)) {
    const taxable = U(wages);
    if (taxable === ZERO) continue;
    additional += mulRateCents(taxable, creditReductionRate(year, region));
  }
  return D(additional);
}

export function calculatePub15T(input: Pub15TInput): Pub15TResult {
  const rates: YearRates = ratesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) throw new PayrollError(`invalid pay periods per year: ${P}`);
  if (input.nonresidentAlien) {
    // IRS Publication 15-T (2026), Nonresident alien employees, Tables 1–2:
    // https://www.irs.gov/publications/p15t
    throw new PayrollError(
      "Federal withholding for a nonresident-alien employee requires the Pub. 15-T Table 1 or Table 2 "
      + "payroll-period wage adjustment and the applicable student/apprentice exception review; "
      + "this calculation path does not implement those rules, so do not calculate or post this employee's federal payroll here — refused by name",
    );
  }

  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const wages = U(input.wages);
  const supplemental = opt(input.supplemental);
  const ficaWages = input.ficaWages === undefined ? wages + supplemental : U(input.ficaWages);
  const futaWages = input.futaWages === undefined ? wages + supplemental : U(input.futaWages);
  const ytd = input.ytd ?? {};

  // ---- FIT: Worksheet 1A over the periodic wages ---------------------------
  const annualWages = mulInt(wages, P); // 1b
  let adjusted: bigint; // 1i / 1l — Adjusted Annual Wage Amount
  let schedule: WithholdingRow[];
  if (input.pre2020) {
    const allowances = input.pre2020.allowances;
    if (!Number.isInteger(allowances) || allowances < 0) {
      throw new PayrollError(`invalid W-4 allowances: ${allowances}`);
    }
    adjusted = max0(annualWages - mulInt(U(rates.allowanceAmount), allowances));
    schedule = rates.standard[input.pre2020.married ? "married_joint" : "single"];
  } else {
    const otherIncome = opt(input.otherIncomeAnnual); // 1c
    const deductions = opt(input.deductionsAnnual); // 1e
    const adjustment = input.multipleJobs
      ? ZERO
      : U(input.filingStatus === "married_joint"
          ? rates.wageAdjustment.marriedJoint
          : rates.wageAdjustment.other); // 1g
    adjusted = max0(annualWages + otherIncome - deductions - adjustment);
    schedule = (input.multipleJobs ? rates.checkbox : rates.standard)[input.filingStatus];
  }
  trace("AAWA", adjusted);

  const row = rowFor(schedule, adjusted);
  const tentativeAnnual = U(row.tentative) + mulRateCents(adjusted - U(row.atLeast), row.rate); // 2g
  const tentativePerPeriod = divIntCents(tentativeAnnual, P); // 2h
  const creditPerPeriod = divIntCents(opt(input.dependentCredits), P); // 3b
  const extra = opt(input.extraPerPeriod); // 4a
  const periodicFit = input.fitExempt ? ZERO : max0(tentativePerPeriod - creditPerPeriod); // 3c
  trace("TW", tentativeAnnual);
  trace("TWP", tentativePerPeriod);

  // ---- FIT: flat-rate method over the supplemental payment -----------------
  // Pub. 15 §7 method 1b: when no FIT was withheld from regular wages in
  // the current or preceding year, the optional flat rate is unavailable.
  // 1b combines the supplement with the most recent regular wage, withholds
  // on the total through the same worksheet, and subtracts the FIT already
  // withheld. The recursion reuses the worksheet (no extra: the additional
  // per-period amount is added once below, never inside the 1b difference).
  // A mandatory-37% excess beside a 1b payment is refused — the $1M corner
  // needs its own transcription, not a guessed blend of the two methods.
  let supplementalFit = ZERO;
  if (supplemental > ZERO) {
    const priorSupplemental = opt(ytd.supplemental);
    const threshold = U(rates.supplemental.mandatoryThreshold);
    const atFlat = cappedSlice(supplemental, threshold, priorSupplemental);
    const mandatory = mulRateCents(supplemental - atFlat, rates.supplemental.mandatoryHighRate);
    if (input.noRegularFitWithheld === true && !input.fitExempt) {
      const basis = input.supplementalRegularBasis;
      if (!basis) {
        throw new PayrollError(
          "federal supplemental wages cannot use the optional flat rate: no FIT was withheld "
          + "from regular wages in the current or preceding year, so Pub. 15 §7 requires method 1b. "
          + "Provide the most recent regular wage and the FIT already withheld from it "
          + "(supplementalRegularBasis) before calculating — refused by name",
        );
      }
      if (supplemental - atFlat > ZERO) {
        throw new PayrollError(
          "federal supplemental wages exceed the $1,000,000 mandatory-37% threshold inside a "
          + "method-1b payment; the 1b aggregate beside a mandatory excess is not transcribed — refused by name",
        );
      }
      const combined = calculatePub15T({
        ...input,
        wages: D(U(basis.recentRegularWages) + supplemental),
        supplemental: "0",
        extraPerPeriod: undefined,
        noRegularFitWithheld: undefined,
        supplementalRegularBasis: undefined,
      });
      // combined.fit carries no extra and no supplemental share: the pure
      // worksheet on the aggregate. The 1b share is the aggregate withholding
      // less what regular withholding already took.
      supplementalFit = max0(U(combined.fit) - U(basis.regularFitWithheld)) + mandatory;
    } else {
      // Pub. 15 §7 makes the 37% slice mandatory regardless of the employee's
      // W-4 exemption election; only the optional lower flat slice is waived.
      supplementalFit = (input.fitExempt ? ZERO : mulRateCents(atFlat, rates.supplemental.flatRate))
        + mandatory;
    }
  }
  const fit = periodicFit + supplementalFit + (input.fitExempt ? ZERO : extra);
  trace("FIT", fit);
  trace("FIT_S", supplementalFit);

  // ---- FICA ----------------------------------------------------------------
  let ss = ZERO;
  let medicare = ZERO;
  let additionalMedicare = ZERO;
  if (!input.ficaExempt) {
    const ssTaxable = cappedSlice(ficaWages, U(rates.fica.ssWageBase), opt(ytd.ssWages));
    ss = mulRateCents(ssTaxable, rates.fica.ssRate);
    medicare = mulRateCents(ficaWages, rates.fica.medicareRate);
    const priorMedicareWages = opt(ytd.medicareWages);
    const threshold = U(rates.fica.additionalMedicareThreshold);
    const overThreshold = max0(priorMedicareWages + ficaWages - threshold)
      - max0(priorMedicareWages - threshold);
    additionalMedicare = mulRateCents(overThreshold, rates.fica.additionalMedicareRate);
    // Carry the exact threshold-crossing wage slice so the quarterly Form 941
    // can report line 5d separately from ordinary Medicare wages on line 5c.
    trace("MED2_TAXABLE", overThreshold);
    trace("SS_TAXABLE", ssTaxable);
  }
  trace("SS", ss);
  trace("MED", medicare);
  trace("MED2", additionalMedicare);

  // ---- FUTA / SUI (employer only) ------------------------------------------
  let futa = ZERO;
  let suta = ZERO;
  if (!input.futaExempt) {
    const futaTaxable = cappedSlice(futaWages, U(rates.futa.wageBase), opt(ytd.futaWages));
    if (futaTaxable > ZERO) {
      // Net rate only: the tenant us_futa rate or the statutory 0.6% default.
      // Schedule A credit reduction is a Form 940 year-end true-up
      // (futaScheduleATrueUp), never a pay-run gate — the schedule publishes
      // in November, after most of the year's pay runs.
      const rate = input.futaEffectiveRate ?? rates.futa.fullCreditEffectiveRate;
      futa = mulRateCents(futaTaxable, rate);
    }
  }
  if (!input.suiExempt && input.sui) {
    const suiTaxable = cappedSlice(futaWages, U(input.sui.wageBase), opt(ytd.suiWages));
    suta = mulRateCents(suiTaxable, input.sui.rate);
  }
  trace("FUTA", futa);
  trace("SUTA", suta);

  return {
    year: rates.year,
    fit: D(fit),
    fitSupplemental: D(supplementalFit),
    ss: D(ss),
    ssEmployer: D(ss),
    medicare: D(medicare),
    medicareEmployer: D(medicare),
    additionalMedicare: D(additionalMedicare),
    futa: D(futa),
    suta: D(suta),
    factors,
  };
}
