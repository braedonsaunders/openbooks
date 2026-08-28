/**
 * The contract a US state withholding engine satisfies.
 *
 * There is deliberately NO single "state tax table" shape here, and that is the
 * central design decision of this directory. The four states delivered in this
 * wave compute withholding four genuinely different ways:
 *
 *   Pennsylvania  a flat rate on compensation, no allowances, no deduction,
 *                 no brackets, no filing status. Three lines of arithmetic.
 *   Illinois      a flat rate on wages less two kinds of annual allowance
 *                 divided by the pay periods in the year.
 *   Illinois/PA   both apply their rate to a PERIODIC amount.
 *   New York      annualizes, looks the annual amount up in a bracket schedule
 *                 with an allowance subtraction and a phase-in recapture, and
 *                 de-annualizes.
 *   California    does not annualize at all in its primary method: it prints
 *                 TWENTY-FOUR rate tables (eight pay periods × three filing
 *                 schedules), tests a low-income exemption first, subtracts a
 *                 per-period standard deduction, and then subtracts a per-period
 *                 tax CREDIT rather than a wage allowance.
 *
 * A common shape wide enough to hold all four would have optional fields for
 * every state's peculiarity, and the first state whose peculiarity did not fit
 * would be approximated into the nearest one that did. That is precisely the
 * failure this repository refuses elsewhere: `engine/src/payroll/canada/` does
 * not force Revenu Québec's TP-1015 into the CRA's T4127 shape, it gives Québec
 * its own engine beside the federal one and shares only the exact-decimal
 * primitives.
 *
 * So: each state owns its algorithm, expressed the way its own publication
 * expresses it, and exports a `UsStateWithholdingEngine`. What is shared is the
 * INTERFACE (this module), the edition/refusal discipline, and money.ts. The
 * generic layer above knows only the interface.
 */
import type { ResolvedCertificate } from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";

/**
 * The printed pay periods a state's tables may be published for.
 *
 * `daily` covers the "Daily or Miscellaneous" column several states print.
 */
export type UsStatePayPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "semiannual" | "annual" | "daily";

/** Pay periods per year → the printed period name, or null when there is none. */
export function payPeriodFor(periodsPerYear: number): UsStatePayPeriod | null {
  switch (periodsPerYear) {
    case 52: return "weekly";
    case 26: return "biweekly";
    case 24: return "semimonthly";
    case 12: return "monthly";
    case 4: return "quarterly";
    case 2: return "semiannual";
    case 1: return "annual";
    case 260:
    case 365: return "daily";
    default: return null;
  }
}

/** Year-to-date figures a state engine may need. */
export interface UsStateYtd {
  /** State-taxable wages before this period, this employer. */
  wages?: string;
  /** Supplemental wages before this period. */
  supplemental?: string;
  /** Tax already withheld to this state this year. */
  tax?: string;
}

export interface UsStateWithholdingInput {
  /** Pay date — selects the edition (tax year). */
  payDate: string;
  /**
   * Employer headcount for state rules that apply only once an employer
   * reaches a statutory threshold (Nebraska's special procedure is one).
   * The payroll run resolves this from the paying legal entity; standalone
   * conformance callers may omit it for states that have no such rule.
   */
  employerEmployeeCount?: number;
  /**
   * First day of the payroll period this payment covers, when the caller
   * knows it. Utah keys its tables to the period START rather than the pay
   * date; that engine refuses without this field instead of applying a table
   * based on an unrelated date.
   */
  periodStart?: string;
  /**
   * The last day of the payroll period this payment covers, when the caller
   * knows it.
   *
   * Optional because most states key their tables to the PAY date and do not
   * need it. Ohio does: the Department's table sets apply to "any payroll
   * ending on or after" their effective date, whatever date it is paid, and its
   * 2026 rates change on 1 August. A state that needs this REFUSES without it
   * rather than substituting `payDate` — the same shape as `regionTax` below,
   * which the Yonkers resident surcharge refuses without.
   */
  periodEnd?: string;
  /** P — pay periods in the year. */
  periodsPerYear: number;
  /** Gross state-taxable periodic wages (excludes supplemental). */
  wages: string;
  /** Supplemental wages this period (bonus, commission, severance). */
  supplemental?: string;
  /**
   * The employee's answers on the state's withholding certificate, resolved
   * against the pack's declaration. Never a bag of loose fields: a state engine
   * reads through `certificateCount`/`certificateAmount`/`certificateChoice`,
   * which refuse a value the declaration does not admit.
   */
  certificate: ResolvedCertificate;
  /**
   * Whether the employee is a RESIDENT of the state or works there as a
   * nonresident. Several states withhold differently, and every state's
   * publication assumes one of the two without saying which.
   */
  basis: "resident" | "nonresident";
  /**
   * The REGION's withholding for this period, when a sub-region levy is
   * computed FROM it rather than from wages.
   *
   * Yonkers is the case that forces this to exist: the Yonkers resident tax is
   * a surcharge of 16.75% of the New York State withholding, not a rate on
   * wages. A sub-region engine that recomputed the state tax itself would be a
   * second copy of New York's schedules, guaranteed to drift. So the resolution
   * computes the region first (which the resolution order already requires for
   * an unrelated reason — the residence-region credit) and hands the result
   * down.
   */
  regionTax?: string;
  /**
   * Employee-side statutory retirement and social-insurance contributions
   * withheld from this payment, when a region's method subtracts them.
   *
   * Massachusetts is the case: Circular M's percentage method opens by
   * subtracting "the amount deducted for the U.S. Social Security (FICA),
   * Medicare, Massachusetts, United States or Railroad Retirement systems", up
   * to $2,000 a year. Nothing else in this pack has needed it, which is why it
   * is optional; a caller that omits it over-withholds by at most the tax on
   * $2,000 a year, and the omission is reported in the result's factors rather
   * than being invisible.
   */
  socialInsuranceDeducted?: {
    /** Deducted from THIS payment. */
    period: string;
    /** Deducted earlier this year, for the annual cap. */
    yearToDate?: string;
  };
  ytd?: UsStateYtd;
}

export interface UsStateWithholdingResult {
  state: string;
  year: number;
  /** State income tax withheld this period, including any extra amount. */
  tax: string;
  /** The supplemental-wage share of `tax`, when the state has a separate rule. */
  taxSupplemental: string;
  /** Every intermediate line, for the explainability trace. */
  factors: Record<string, string>;
}

/**
 * A state's engine.
 *
 * `editions` is the same declaration `PayrollTaxYearSupport` carries for a
 * country, at region scope — so an unloaded state-year is a NAMED READINESS
 * BLOCKER surfaced before a run calculates, rather than an exception thrown
 * from inside `calculateStub` per employee in the middle of a payroll.
 */
export interface UsStateWithholdingEngine {
  /** Postal code. */
  state: string;
  /** What the state calls the tax, for stub lines ("California PIT"). */
  label: string;
  /**
   * The certificate key whose answers `compute` reads, or null when the
   * jurisdiction publishes no withholding certificate at all.
   *
   * Null is a real answer, not a gap: Pennsylvania has no allowance certificate
   * of any kind, because its rate is flat and there is nothing an employee
   * could elect. Its only employee-filed form, REV-419, switches withholding
   * OFF under a reciprocal agreement, which makes it a `non_residence`
   * certificate the RESOLVER consults — not something this engine reads.
   */
  certificateKey: string | null;
  /** The module a new edition is transcribed into — named in every refusal. */
  ratesModule: string;
  editions: readonly PayrollTaxYearEdition[];
  /**
   * Pay periods the state's tables are printed for, or null when the state's
   * method annualizes and therefore accepts any P. A state with printed
   * per-period tables REFUSES a P it has no table for rather than scaling one,
   * because a scaled table is not the published table.
   */
  printedPeriods: readonly UsStatePayPeriod[] | null;
  compute(input: UsStateWithholdingInput): UsStateWithholdingResult;
}

/**
 * The refusal every state engine raises for a year it has not transcribed.
 * Shared so the sentence is identical across states and names the same three
 * things: what is missing, where it goes, and how to scaffold it.
 */
export function refuseUntranscribedYear(
  engine: Pick<UsStateWithholdingEngine, "state" | "label" | "ratesModule" | "editions">,
  year: number,
): never {
  const published = engine.editions
    .filter((edition) => edition.status === "published")
    .map((edition) => edition.year)
    .sort((a, b) => a - b);
  const draft = engine.editions
    .filter((edition) => edition.status === "draft" && !published.includes(edition.year))
    .map((edition) => edition.year);
  if (draft.includes(year)) {
    throw new Error(
      `the ${year} ${engine.label} withholding tables are scaffolded but not transcribed — `
      + `placeholder values remain in ${engine.ratesModule}. Fill them in from the state's own `
      + "publication and flip the edition to published before paying into " + year + ".",
    );
  }
  throw new Error(
    `${year} ${engine.label} withholding tables are not loaded — `
    + (published.length > 0 ? `loaded years: ${published.join(", ")}. ` : "no years are loaded. ")
    + `Transcribe the ${year} edition of the state's published withholding schedules into `
    + `${engine.ratesModule}. Never extrapolate the prior year: a state's brackets, allowance `
    + "amounts and rates all move independently.",
  );
}

/** The refusal for a pay frequency the state prints no table for. */
export function refuseUnprintedPeriod(
  engine: Pick<UsStateWithholdingEngine, "label" | "printedPeriods">,
  periodsPerYear: number,
): never {
  throw new Error(
    `${engine.label} publishes withholding tables for `
    + `${(engine.printedPeriods ?? []).join(", ")} pay periods, and this payroll runs `
    + `${periodsPerYear} periods a year. The state's method is a per-period TABLE lookup, not a `
    + "formula, so there is nothing to scale: change the pay schedule to a published frequency, "
    + "or transcribe the state's table for this one.",
  );
}
