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
import { PayrollError } from "../../error.ts";
import { D, rate6, U } from "../../canada/decimal.ts";
import { fromUnits, roundDiv, toUnits } from "../../../money/money.ts";
import type { ResolvedCertificate } from "../../certificates.ts";
import type { PayrollWorkAllocation } from "../../statutory-context.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import type { PayrollStateTaxBaseKey } from "../../packs.ts";

/**
 * The printed pay periods a state's tables may be published for.
 *
 * `daily` covers the "Daily or Miscellaneous" column several states print.
 */
export type UsStatePayPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "semiannual" | "annual" | "daily";

/** Whether the supplemental amount shares the regular wage payment. */
export type UsSupplementalPaymentTiming = "combined" | "separate";

/** Per-state rounding applied to the final period amount after certificate extras. */
export type UsFinalWithholdingRounding = "nearest_dollar" | "ceiling_dollar";

/** Apply the pack-declared whole-dollar rule to the final exact amount. */
export function roundUsFinalWithholding(
  amount: bigint,
  rule: UsFinalWithholdingRounding | undefined,
): bigint {
  if (!rule) return amount;
  const dollar = 10_000n;
  if (rule === "nearest_dollar") return roundDiv(amount, dollar) * dollar;
  if (amount <= 0n) return 0n;
  return ((amount + dollar - 1n) / dollar) * dollar;
}

/** The US use of the shared payroll work-allocation contract. */
export type UsWageAllocation = PayrollWorkAllocation;

/** The actual withholding facts a resident-credit state needs this period. */
export interface UsResidentWithholdingFacts {
  /** Wages this period sourced outside the employee's residence region. */
  outOfRegionWages: string;
  /** Tax actually computed on those wages by work-region withholding. */
  workRegionTaxes: readonly { region: string; amount: string }[];
  /** Current-period wages sourced to each out-of-region work state. */
  workRegionWages: readonly { region: string; amount: string }[];
}

/** Jurisdiction-declared annual nonresident exception evaluated on shared facts. */
export interface UsNonresidentThresholdRule {
  /** Calendar-year service-day test, or a calendar-year source-wage test. */
  measure: "service_days" | "source_wages";
  /** The statutory maximum exempt count/amount, in days or exact currency. */
  threshold: number | string;
  /** `>` means the employee remains exempt at the printed limit; `>=` does not. */
  crossing: ">" | ">=";
  /** Wage tests may also compare the current payroll's annualized source wages. */
  annualizeCurrentWages?: boolean;
  /** Whether crossing makes the current pay catch up prior exempt source wages. */
  catchUpPriorWages: boolean;
  /** Name used in the refusal and calculation trace. */
  label: string;
}

export interface UsNonresidentThresholdResult {
  crossed: boolean;
  currentSourceWages: string;
  catchUpSourceWages: string;
  periodsBeforeCurrent: number | null;
}

/**
 * Apply a state's declared nonresident exception to the shared work contract.
 * Prior wages are reconstructed by payroll-context from committed stubs; no
 * operator-entered YTD total is accepted here.
 */
export function evaluateUsNonresidentThreshold(
  allocation: UsWageAllocation,
  rule: UsNonresidentThresholdRule,
  periodsPerYear: number,
): UsNonresidentThresholdResult {
  const currentWages = allocation.sourceWagesCurrentPeriod;
  const priorWages = allocation.sourceWagesYearToDate;
  const compare = (value: bigint, limit: bigint) => rule.crossing === ">"
    ? value > limit : value >= limit;
  let crossed: boolean;
  let wasCrossed: boolean;
  let current = 0n;
  let prior = 0n;
  if (rule.measure === "service_days") {
    if (allocation.serviceDaysYearToDate == null || allocation.serviceDaysCurrentPeriod == null) {
      throw new PayrollError(
        `${rule.label} needs verified calendar-year and current-period service days; `
        + "record approved dated work or HR service-day evidence before calculating; refused by name",
      );
    }
    const daysBefore = allocation.serviceDaysYearToDate - allocation.serviceDaysCurrentPeriod;
    crossed = compare(BigInt(allocation.serviceDaysYearToDate), BigInt(rule.threshold));
    wasCrossed = compare(BigInt(daysBefore), BigInt(rule.threshold));
  } else {
    if (currentWages == null || priorWages == null) {
      throw new PayrollError(
        `${rule.label} needs complete current and committed year-to-date source wages; `
        + "record verified work allocation and establish source-wage history before calculating; refused by name",
      );
    }
    current = U(currentWages);
    prior = U(priorWages);
    const limit = U(String(rule.threshold));
    if (!Number.isInteger(periodsPerYear) || periodsPerYear < 1 || periodsPerYear > 2000) {
      throw new PayrollError(`${rule.label} needs a valid annual payroll frequency; refused by name`);
    }
    const cumulative = prior + current;
    const projected = rule.annualizeCurrentWages ? current * BigInt(periodsPerYear) : 0n;
    crossed = compare(cumulative, limit)
      || (rule.annualizeCurrentWages === true && compare(projected, limit));
    wasCrossed = compare(prior, limit);
  }
  if (crossed && (currentWages == null || priorWages == null)) {
    throw new PayrollError(
      `${rule.label} catch-up needs complete current and committed year-to-date source wages; `
      + "record verified work allocation and establish source-wage history before calculating; refused by name",
    );
  }
  if (crossed && rule.measure === "service_days") {
    current = U(currentWages!);
    prior = U(priorWages!);
  }
  const catchUp = crossed && !wasCrossed && rule.catchUpPriorWages && prior > 0n;
  const periodsBeforeCurrent = allocation.periodsYearToDate == null
    ? null : allocation.periodsYearToDate - 1;
  if (catchUp && (!Number.isInteger(periodsBeforeCurrent) || periodsBeforeCurrent! < 1)) {
    throw new PayrollError(
      `${rule.label} catch-up needs the count of prior committed payroll periods; `
      + "restore the committed payroll history before calculating; refused by name",
    );
  }
  return {
    crossed,
    currentSourceWages: crossed ? D(current) : "0.0000",
    catchUpSourceWages: catchUp ? D(prior) : "0.0000",
    periodsBeforeCurrent: catchUp ? periodsBeforeCurrent : null,
  };
}

/** Resolve one declared work allocation and refuse missing or ambiguous facts. */
export function requireUsWageAllocation(
  allocations: readonly UsWageAllocation[] | undefined,
  region: string,
  subRegion: string | null,
): UsWageAllocation {
  const matches = (allocations ?? []).filter((item) =>
    item.region === region && item.subRegion === subRegion,
  );
  if (matches.length !== 1) {
    throw new PayrollError(
      `${region}/${subRegion} needs exactly one current-period work allocation; found ${matches.length}. `
      + "Record the work share from the employee's certified work-location facts or verified work records before calculating; refused by name",
    );
  }
  const allocation = matches[0]!;
  let share: bigint;
  try {
    share = rate6(allocation.workShare);
  } catch {
    throw new PayrollError(
      `${region}/${subRegion} work allocation must be an exact decimal share from 0 through 1; `
      + "correct the verified work-share input before calculating; refused by name",
    );
  }
  if (share < 0n || share > 1_000_000n || !allocation.source.trim()) {
    throw new PayrollError(
      `${region}/${subRegion} work allocation is outside 0–1 or has no recorded source; `
      + "correct the verified work-share input before calculating; refused by name",
    );
  }
  return allocation;
}

/** Require the payroll-context-computed wage amount for one exact source. */
export function requireUsSourceWages(
  allocations: readonly UsWageAllocation[] | undefined,
  region: string,
  subRegion: string | null,
): string {
  const allocation = requireUsWageAllocation(allocations, region, subRegion);
  if (allocation.sourceWagesCurrentPeriod == null) {
    throw new PayrollError(
      `${region}/${subRegion} needs current-period source wages from the verified work allocation; `
      + "record approved work-location time or an HR allocation before calculating; refused by name",
    );
  }
  try {
    U(allocation.sourceWagesCurrentPeriod);
  } catch {
    throw new PayrollError(
      `${region}/${subRegion} source wages must be an exact non-negative decimal from payroll context; `
      + "correct the work-location records before calculating; refused by name",
    );
  }
  return allocation.sourceWagesCurrentPeriod;
}

/** Require the work-region assessment used by a resident withholding credit. */
export function requireUsResidentWithholdingFacts(
  facts: UsResidentWithholdingFacts | undefined,
  creditAgainstRegion: string | undefined,
  residenceRegion: string,
): UsResidentWithholdingFacts {
  const source = `${residenceRegion} resident withholding`;
  if (!facts) {
    throw new PayrollError(
      `${source} needs verified out-of-region wages and same-period work-region taxes; `
      + "supply the allocation and computed work-region taxes before calculating; refused by name",
    );
  }
  try {
    U(facts.outOfRegionWages);
  } catch {
    throw new PayrollError(
      `${source} has no valid out-of-region wage amount; supply the verified current-period allocation before calculating; refused by name`,
    );
  }
  for (const item of facts.workRegionTaxes) {
    try {
      U(item.amount);
    } catch {
      throw new PayrollError(
        `${source} received an invalid ${item.region} tax amount; use computed work-region taxes from this period; refused by name`,
      );
    }
  }
  for (const item of facts.workRegionWages) {
    try {
      U(item.amount);
    } catch {
      throw new PayrollError(
        `${source} received invalid ${item.region} work-region wages; use verified current-period wage allocations; refused by name`,
      );
    }
  }
  if (new Set(facts.workRegionTaxes.map((item) => item.region)).size !== facts.workRegionTaxes.length) {
    throw new PayrollError(
      `${source} received duplicate work-region tax facts; provide one computed amount per region for this period; refused by name`,
    );
  }
  if (creditAgainstRegion) {
    const matches = facts.workRegionTaxes.filter((item) => item.region === creditAgainstRegion);
    if (matches.length !== 1) {
      throw new PayrollError(
        `${source} needs exactly one computed ${creditAgainstRegion} tax amount for this period; `
        + `found ${matches.length}. Compute that work-region withholding or correct its jurisdiction before calculating; refused by name`,
      );
    }
  }
  return facts;
}

/**
 * Derive resident-credit wage and tax inputs from verified region allocations.
 * Subregion shares are intentionally excluded here: they refine a region's
 * allocation for local taxes and must not be counted a second time at state level.
 */
export function resolveUsResidentWithholdingFacts(
  wages: string,
  allocations: readonly UsWageAllocation[] | undefined,
  workRegionTaxes: readonly { region: string; amount: string }[],
  residenceRegion: string,
): UsResidentWithholdingFacts {
  const regional = (allocations ?? []).filter((item) => item.subRegion === null);
  if (regional.length === 0) {
    throw new PayrollError(
      `${residenceRegion} resident withholding needs verified region-level work allocations; `
      + "record sourced work shares before calculating; refused by name",
    );
  }
  const shares = new Map<string, bigint>();
  let totalShare = 0n;
  for (const allocation of regional) {
    if (!allocation.region || !allocation.source.trim() || shares.has(allocation.region)) {
      throw new PayrollError(
        `${residenceRegion} resident withholding received an ambiguous or unsourced region allocation; `
        + "record one sourced share per work region before calculating; refused by name",
      );
    }
    let share: bigint;
    try {
      share = rate6(allocation.workShare);
    } catch {
      throw new PayrollError(
        `${allocation.region} work allocation must be an exact decimal share from 0 through 1; `
        + "correct the verified work-share input before calculating; refused by name",
      );
    }
    if (share < 0n || share > 1_000_000n) {
      throw new PayrollError(
        `${allocation.region} work allocation is outside 0–1; correct the verified work-share input before calculating; refused by name`,
      );
    }
    shares.set(allocation.region, share);
    totalShare += share;
  }
  if (totalShare !== 1_000_000n) {
    throw new PayrollError(
      `${residenceRegion} resident withholding region shares must total exactly 1; `
      + `received ${fromUnits(roundDiv(totalShare * 10_000n, 1_000_000n))}. Correct the sourced work allocations; refused by name`,
    );
  }

  let wagesUnits: bigint;
  try {
    wagesUnits = toUnits(wages);
  } catch {
    throw new PayrollError(
      `${residenceRegion} resident withholding has no valid current-period wage amount; refused by name`,
    );
  }
  const outOfRegionShare = [...shares]
    .filter(([region]) => region !== residenceRegion)
    .reduce((total, [, share]) => total + share, 0n);
  const outOfRegionWages = fromUnits(roundDiv(wagesUnits * outOfRegionShare, 1_000_000n));
  const sourceRegions = [...shares]
    .filter(([region, share]) => region !== residenceRegion && share > 0n)
    .map(([region]) => region);
  const taxByRegion = new Map<string, string>();
  for (const tax of workRegionTaxes) {
    if (taxByRegion.has(tax.region)) {
      throw new PayrollError(
        `${residenceRegion} resident withholding received duplicate ${tax.region} work-region tax facts; `
        + "provide one actual computed amount per work region; refused by name",
      );
    }
    try {
      U(tax.amount);
    } catch {
      throw new PayrollError(
        `${residenceRegion} resident withholding received an invalid ${tax.region} work-region tax amount; refused by name`,
      );
    }
    taxByRegion.set(tax.region, tax.amount);
  }
  const missingTaxRegions = sourceRegions.filter((region) => !taxByRegion.has(region));
  if (missingTaxRegions.length > 0) {
    throw new PayrollError(
      `${residenceRegion} resident withholding needs the same-period computed work-region tax for `
      + `${missingTaxRegions.join(", ")}; compute those work-region assessments before calculating; refused by name`,
    );
  }
  return {
    outOfRegionWages,
    workRegionTaxes: sourceRegions.map((region) => ({ region, amount: taxByRegion.get(region)! })),
    workRegionWages: sourceRegions.map((region) => ({
      region,
      amount: fromUnits(roundDiv(wagesUnits * shares.get(region)!, 1_000_000n)),
    })),
  };
}

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
  /**
   * Local Services Tax already withheld this year, by stub factor key
   * (`LIT_PA-<worksite PSD>-LST`). The annual LST amount caps the year's
   * total per worksite jurisdiction; without this history a 27th pay period
   * or a mid-year schedule change would over-withhold past it.
   */
  lstWithheldYtd?: Record<string, string>;
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
  /** Federal W-4 Step 1(c) status, used by state worksheets that refer to it. */
  federalFilingStatus?: "single" | "married_joint" | "head_household";
  /** Preserved status and allowances from an effective 2019-or-earlier federal W-4. */
  federalLegacyW4?: { status: "single" | "married"; allowances: number };
  /** Federal W-4 exempt claim; some state worksheets inherit its withholding result. */
  federalTaxExempt?: boolean;
  /** Federal W-4 additional tax per period, for state-declared fallback rules. */
  federalAdditionalPerPeriod?: string;
  /** Whether the state withholding certificate itself is filed and effective. */
  stateCertificateOnFile?: boolean;
  /** Supplemental wages this period (bonus, commission, severance). */
  supplemental?: string;
  /** Required by the pack dispatcher whenever supplemental wages are present. */
  supplementalPaymentTiming?: UsSupplementalPaymentTiming;
  /**
   * Nonresident wage facts for threshold states, as exact decimal strings.
   * Wisconsin's W-166 $1,500 rule withholds nothing while expected annual
   * Wisconsin wages sit below $1,500 and the running total has not reached
   * it, then withholds the crossing check in full; that engine refuses a
   * nonresident calculation without both figures rather than assuming
   * either side of the threshold.
   */
  nonresidentExpectedAnnualWages?: string;
  nonresidentYtdWages?: string;
  /**
   * Federal income tax withheld by the CURRENT paycheck's Pub 15-T pass.
   * Alabama and Oregon subtract this amount in their state formulas; it is a
   * computed statutory result, never an employee certificate answer.
   */
  federalIncomeTax?: string;
  /**
   * Tax-qualified deductions from this period's wages. Nebraska's special
   * 1.5% floor is assessed on gross wages after these deductions, rather than
   * on the ordinary allowance-reduced percentage-method base.
   */
  taxQualifiedDeductions?: string;
  /**
   * The employee's answers on the state's withholding certificate, resolved
   * against the pack's declaration. Never a bag of loose fields: a state engine
   * reads through `certificateCount`/`certificateAmount`/`certificateChoice`,
   * which refuse a value the declaration does not admit.
   */
  certificate: ResolvedCertificate;
  /** Other declared certificates this engine requires alongside its primary form. */
  supportingCertificates?: Readonly<Record<string, ResolvedCertificate>>;
  /**
   * Whether the employee is a RESIDENT of the state or works there as a
   * nonresident. Several states withhold differently, and every state's
   * publication assumes one of the two without saying which.
   */
  basis: "resident" | "nonresident";
  /** Federal Form W-4 total-exemption status, used by Illinois to validate the IL-W-4 total exemption claim. */
  federalWithholdingExempt?: boolean;
  /** Employee's effective residence region, for subject-scoped certificates. */
  residenceRegion?: string;
  /** Resolve another pack-declared certificate used by this jurisdiction. */
  certificateFor?: (key: string) => ResolvedCertificate | null;
  /** Shared verified work-location shares for local and state variants. */
  wageAllocations?: readonly UsWageAllocation[];
  /** Inputs required when this levy is a residence-region claim on out-of-region pay. */
  residentWithholdingFacts?: UsResidentWithholdingFacts;
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
  /** Michigan Form 5469 resident rate after the other work city's nonresident offset. */
  detroitResidentRateOverride?: string;
  /**
   * The employer's reasonable expectation of the employee's annual earnings in
   * THIS state, when the employer asserts one. Wisconsin reads it for the
   * §3.I(4)(b) under-$1,500 nonresident exception; without it the engine
   * annualizes this period's Wisconsin wages as the estimate. No other state
   * reads it. A malformed or negative assertion refuses — an expectation is a
   * fact the employer states, never a value the engine repairs.
   */
  wiExpectedAnnualWages?: string;
}

export interface UsStateWithholdingResult {
  state: string;
  year: number;
  /** State income tax withheld this period, including any extra amount. */
  tax: string;
  /** Tax from the statutory method before any requested extra amount. */
  statutoryTax?: string;
  /** Employee-elected extra, never reduced by a resident credit. */
  additionalWithholding?: string;
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
  /** Additional pack-declared certificates read by this state calculation. */
  supportingCertificateKeys?: readonly string[];
  /**
   * State-specific taxable wage bases declared by this engine's statute.
   * The shared adapter requires both bases when declared; it never guesses
   * which deductions are excluded by a state.
   */
  taxableWageBases?: { income: PayrollStateTaxBaseKey; nonPeriodic: PayrollStateTaxBaseKey };
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
  /** Final whole-dollar convention, applied only after all elected additions. */
  finalRounding?: UsFinalWithholdingRounding;
  compute(input: UsStateWithholdingInput): UsStateWithholdingResult;
}

/**
 * The refusal every state engine raises for a year it has not transcribed.
 * Shared so the sentence is identical across states: what is missing, and
 * the operator remedy — rates for a new year arrive with a pack update,
 * never a scaffold script. The "never extrapolate" warning stays because it
 * constrains the OPERATOR too (do not pay into the year on last year's
 * tables by hand).
 */
export function refuseUntranscribedYear(
  engine: Pick<UsStateWithholdingEngine, "state" | "label" | "editions">,
  year: number,
): never {
  const published = engine.editions
    .filter((edition) => edition.status === "published")
    .map((edition) => edition.year)
    .sort((a, b) => a - b);
  if (engine.editions.some((edition) => edition.year === year && edition.status === "draft")) {
    throw new PayrollError(
      `the ${year} ${engine.label} withholding tables are not available in this pack version — `
      + `a pay date in ${year} cannot be calculated; update the pack before paying into ${year}.`,
    );
  }
  throw new PayrollError(
    `the ${year} ${engine.label} withholding tables are not available in this pack version `
    + (published.length > 0 ? `(loaded years: ${published.join(", ")}); ` : "; ")
    + "update the pack. Never extrapolate the prior year: a state's brackets, allowance "
    + "amounts and rates all move independently.",
  );
}

/** The refusal for a pay frequency the state prints no table for. */
export function refuseUnprintedPeriod(
  engine: Pick<UsStateWithholdingEngine, "label" | "printedPeriods">,
  periodsPerYear: number,
): never {
  throw new PayrollError(
    `${engine.label} publishes withholding tables for `
    + `${(engine.printedPeriods ?? []).join(", ")} pay periods, and this payroll runs `
    + `${periodsPerYear} periods a year. The state's method is a per-period TABLE lookup, not a `
    + "formula, so there is nothing to scale: change the pay schedule to a published frequency, "
    + "or transcribe the state's table for this one.",
  );
}
