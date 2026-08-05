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
 *
 * Out of scope in this wave (documented, not forgotten): state income tax
 * withholding (v1 covers the nine no-withholding states), nonresident-alien
 * additional amounts, and Form W-4P pension withholding.
 */
import { bmin, D, divIntCents, max0, mulInt, mulRateCents, U } from "../canada/decimal";
import { type FilingStatus, ratesForPayDate, type WithholdingRow, type YearRates } from "./rates";

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

  /** Statutory exemptions (e.g. F-1 students, some family employment). */
  ficaExempt?: boolean;
  futaExempt?: boolean;

  /** Effective FUTA rate override (credit-reduction states). Default 0.6%. */
  futaEffectiveRate?: string;
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

export function calculatePub15T(input: Pub15TInput): Pub15TResult {
  const rates: YearRates = ratesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) throw new Error(`invalid pay periods per year: ${P}`);

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
      throw new Error(`invalid W-4 allowances: ${allowances}`);
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
  let periodicFit = input.fitExempt ? ZERO : max0(tentativePerPeriod - creditPerPeriod); // 3c
  trace("TW", tentativeAnnual);
  trace("TWP", tentativePerPeriod);

  // ---- FIT: flat-rate method over the supplemental payment -----------------
  let supplementalFit = ZERO;
  if (supplemental > ZERO && !input.fitExempt) {
    const priorSupplemental = opt(ytd.supplemental);
    const threshold = U(rates.supplemental.mandatoryThreshold);
    const atFlat = cappedSlice(supplemental, threshold, priorSupplemental);
    supplementalFit = mulRateCents(atFlat, rates.supplemental.flatRate)
      + mulRateCents(supplemental - atFlat, rates.supplemental.mandatoryHighRate);
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
    futa = mulRateCents(futaTaxable, input.futaEffectiveRate ?? rates.futa.defaultEffectiveRate);
    if (input.sui) {
      const suiTaxable = cappedSlice(futaWages, U(input.sui.wageBase), opt(ytd.suiWages));
      suta = mulRateCents(suiTaxable, input.sui.rate);
    }
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
