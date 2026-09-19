/**
 * The AU pack's statutory pass for FY 2026–27 (taxYear 2027).
 *
 * Method (agency-quoted throughout — Taxation Administration (Withholding
 * Schedules) Instrument 2026, F2026L00716, Schedule 1): the period's pay is
 * converted to a weekly equivalent x ("fortnightly – divide ... by two.
 * Ignore any cents in the result and then add 99 cents", monthly — "multiply
 * this amount by three and then divide by 13. Ignore any cents in the result
 * and then add 99 cents" after the 33-cent rule, quarterly — "divide ...
 * by 13. Ignore any cents in the result and then add 99 cents"), the TFN
 * declaration selects scale 1 (no threshold claim), 2 (threshold claimed)
 * or 3 (foreign resident), and a Medicare levy variation declaration
 * claiming a full or half exemption takes scale 5 or 6 instead — even
 * where the threshold is also claimed (General example 2). The weekly
 * withholding y = ax − b is rounded
 * ("rounded to the nearest dollar. Values ending in 50 cents are rounded up
 * to the next dollar. Do this rounding directly"), and the rounded weekly
 * figure is converted back ("fortnightly – ... Multiply this amount by two.
 * monthly – ... Multiply this amount by 13, divide the product by three and
 * round the result to the nearest dollar. quarterly – ... Multiply this
 * amount by 13"). "Scales 1, 2, 4 and 6 incorporate the Medicare levy", so
 * no separate Medicare step runs. Where the payee has an STSL debt the
 * Schedule 8 combined with-STSL table for the scale applies (the
 * instrument's combined values win over base-plus-component sums).
 *
 * No tax offsets and no Medicare levy adjustment: the instrument allows
 * offsets "only where scales 2, 5 or 6 are applied" via the Withholding
 * declaration and the WLA only where a Medicare levy variation declaration
 * was lodged — neither declaration is carried, so both are nil by the
 * instrument's own conditions.
 *
 * Refused by name: no-TFN payees (scale 4), foreign residents claiming a
 * Medicare exemption (no quotable scale covers the combination), working
 * holiday makers (Schedule 15), pay frequencies outside
 * weekly/fortnightly/monthly/quarterly, the family/spouse levy adjustment
 * (WLA) machinery, and every other schedule — see AU_REFUSED_2027.
 *
 * Money: bigint units (1e4) throughout via the repo's money.ts — the same
 * discipline as canada/decimal.ts. Coefficients stay decimal strings.
 */
import { fromUnits, roundDiv, toUnits } from "../../money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import {
  AU_SCHEDULE1_SCALE1_2027,
  AU_SCHEDULE1_SCALE1_STSL_2027,
  AU_SCHEDULE1_SCALE2_2027,
  AU_SCHEDULE1_SCALE2_STSL_2027,
  AU_SCHEDULE1_SCALE3_2027,
  AU_SCHEDULE1_SCALE3_STSL_2027,
  AU_SCHEDULE1_SCALE5_2027,
  AU_SCHEDULE1_SCALE5_STSL_2027,
  AU_SCHEDULE1_SCALE6_2027,
  AU_SCHEDULE1_SCALE6_STSL_2027,
  type AuSchedule1Row,
} from "./schedule1-2027.ts";
import { AU_SUPER_2027 } from "./tax-year-2027.ts";

const U = (s: string | number): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);

const RATE6 = 1_000_000n;
const CENT = 100n;
const DOLLAR = 10_000n;

function rate6(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  const negative = whole.startsWith("-");
  const digits = (negative ? whole.slice(1) : whole) + (fraction + "000000").slice(0, 6);
  const magnitude = BigInt(digits === "" ? "0" : digits);
  return negative ? -magnitude : magnitude;
}

/** amount × rate, exact in units (rates carry ≤4dp, units carry 4dp). */
function mulRate(u: bigint, rate: string): bigint {
  return (u * rate6(rate)) / RATE6;
}

/** Round units half-up to the cent. */
function r2(u: bigint): bigint {
  return roundDiv(u, CENT) * CENT;
}

/** Whole dollars in units, truncating any cents. */
function wholeDollars(u: bigint): bigint {
  return (u / DOLLAR) * DOLLAR;
}

export interface Au2027Input {
  /** Period earnings for a weekly/fortnightly/monthly/quarterly pay, decimal. */
  income: string;
  residency: "australian_resident" | "foreign_resident";
  workingHolidayMaker: boolean;
  /** TFN declaration: threshold claimed from THIS payer (scale 2 vs 1). */
  claimsThreshold: boolean;
  /** Medicare levy variation declaration: full takes scale 5, half scale 6. */
  medicareExemption: "none" | "full" | "half";
  tfnQuoted: boolean;
  stslDebt: boolean;
  /** Period ordinary-time earnings (qualifying-earnings proxy), decimal. */
  pensionable: string;
  /** One of 52 (weekly), 26 (fortnightly), 12 (monthly), 4 (quarterly). */
  periodsPerYear: number;
}

export interface Au2027Result {
  /** Period PAYG withholding (income tax + Medicare + STSL), 4dp string. */
  payg: string;
  /** Period Super Guarantee accrual (employer), 4dp string. */
  sg: string;
}

/** The Schedule 1 table for this payee, or a named refusal. */
function scaleFor(input: Au2027Input): readonly AuSchedule1Row[] {
  if (!input.tfnQuoted) {
    throw new PayrollPackError(
      "AU PAYG withholding with no quoted TFN is refused by name: scale 4 "
      + "(resident 47%, foreign resident 45%) is a flat-rate cents-ignored "
      + "withholding the engine does not compute (see AU_REFUSED_2027)",
    );
  }
  if (input.workingHolidayMaker) {
    throw new PayrollPackError(
      "AU PAYG withholding for working holiday makers is refused by name: "
      + "Schedule 15 turns on registered-employer status and year-to-date "
      + "payments the pack cannot see (see AU_REFUSED_2027)",
    );
  }
  // The Medicare exemption outranks the threshold claim: the instrument's
  // General example 2 claims the tax-free threshold AND a full Medicare
  // exemption, and "Therefore, Scale 5 is applied".
  if (input.medicareExemption !== "none") {
    if (input.residency === "foreign_resident") {
      throw new PayrollPackError(
        "AU PAYG withholding for a foreign resident claiming a Medicare "
        + "levy exemption is refused by name: no quotable scale covers the "
        + "combination (see AU_REFUSED_2027)",
      );
    }
    if (input.medicareExemption === "full") {
      return input.stslDebt ? AU_SCHEDULE1_SCALE5_STSL_2027 : AU_SCHEDULE1_SCALE5_2027;
    }
    return input.stslDebt ? AU_SCHEDULE1_SCALE6_STSL_2027 : AU_SCHEDULE1_SCALE6_2027;
  }
  if (input.residency === "foreign_resident") {
    return input.stslDebt ? AU_SCHEDULE1_SCALE3_STSL_2027 : AU_SCHEDULE1_SCALE3_2027;
  }
  if (input.claimsThreshold) {
    return input.stslDebt ? AU_SCHEDULE1_SCALE2_STSL_2027 : AU_SCHEDULE1_SCALE2_2027;
  }
  return input.stslDebt ? AU_SCHEDULE1_SCALE1_STSL_2027 : AU_SCHEDULE1_SCALE1_2027;
}

/**
 * Weekly equivalent x in units: whole dollars plus 99 cents, per the
 * instrument's per-frequency rules. Allowances are unseen, so earnings
 * alone enter (the instrument adds allowances to earnings first).
 */
function weeklyEquivalent(incomeUnits: bigint, periodsPerYear: number): bigint {
  if (incomeUnits < 0n) {
    throw new PayrollPackError(
      `AU PAYG withholding needs non-negative income, got ${D(incomeUnits)}`,
    );
  }
  let whole: bigint;
  if (periodsPerYear === 52) {
    whole = wholeDollars(incomeUnits);
  } else if (periodsPerYear === 26) {
    whole = wholeDollars(incomeUnits / 2n);
  } else if (periodsPerYear === 12) {
    let cents = incomeUnits / 100n;
    if (cents % 100n === 33n) cents += 1n;
    whole = ((cents * 3n) / (13n * 100n)) * DOLLAR;
  } else if (periodsPerYear === 4) {
    whole = (incomeUnits / (13n * DOLLAR)) * DOLLAR;
  } else {
    throw new PayrollPackError(
      `AU PAYG withholding for ${periodsPerYear} pays per year is refused by `
      + "name: the instrument publishes weekly, fortnightly, monthly and "
      + "quarterly methods only (see AU_REFUSED_2027)",
    );
  }
  return whole + 9900n;
}

/** Weekly withholding in whole dollars: y = ax − b, 50c up, directly. */
function weeklyWithholding(xUnits: bigint, scale: readonly AuSchedule1Row[]): bigint {
  const threshold = (lessThan: string): bigint => U(lessThan);
  const row = scale.find((candidate) =>
    candidate.lessThan === null || xUnits < threshold(candidate.lessThan),
  );
  if (row === undefined || row.a === null || row.b === null) return 0n;
  const yScaled = rate6(row.a) * xUnits - U(row.b) * RATE6;
  if (yScaled <= 0n) return 0n;
  return (yScaled + 5_000_000_000n) / 10_000_000_000n;
}

export function calculateAu2027(input: Au2027Input): Au2027Result {
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear <= 0) {
    throw new PayrollPackError(
      `AU PAYG withholding needs a positive integer periodsPerYear, got ${input.periodsPerYear}`,
    );
  }
  const scale = scaleFor(input);
  const weekly = weeklyWithholding(weeklyEquivalent(U(input.income), input.periodsPerYear), scale);
  const period = input.periodsPerYear === 52
    ? weekly
    : input.periodsPerYear === 26
      ? weekly * 2n
      : input.periodsPerYear === 12
        ? (weekly * 13n * 2n + 3n) / 6n
        : weekly * 13n;
  // Super Guarantee: 12% of period qualifying earnings (SGAA 17A(2)). No
  // annual maximum-contributions-base cap: the 2026–27 concessional-cap
  // input is refused by name (see AU_REFUSED_2027).
  const sg = r2(mulRate(U(input.pensionable), AU_SUPER_2027.chargeRate));
  return { payg: D(period * DOLLAR), sg: D(sg) };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. I/PI are the pack's payroll inputs.
 */
export const AU_FACTOR_LABELS: Readonly<Record<string, string>> = {
  I: "Periodic income this period",
  PI: "Pensionable earnings this period",
};

export async function computeAuStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const {
    taxYear, pensionable, periodsPerYear,
    reducedBases, pushStatutory, certificateFor, bool,
  } = ctx;
  if (taxYear !== 2027) {
    throw new PayrollPackError(
      `AU PAYG withholding for tax year ${taxYear} has not been transcribed `
      + "— the AU payroll pack's only transcribed edition is 2026–27 "
      + "(taxYear 2027; see tax-year-2027.ts). Transcribe the year's "
      + "legislation before calculating",
    );
  }
  const tfn = certificateFor("au_tfn_declaration");
  const answers = tfn?.answers ?? {};
  const residency = answers["residency"] ?? "australian_resident";
  if (residency !== "australian_resident" && residency !== "foreign_resident") {
    throw new PayrollPackError(
      `AU TFN declaration residency answer "${residency}" is not a declared choice`,
    );
  }
  const variation = certificateFor("au_medicare_levy_variation")?.answers ?? {};
  const medicareExemption = variation["medicare_exemption"] ?? "none";
  if (medicareExemption !== "none" && medicareExemption !== "full" && medicareExemption !== "half") {
    throw new PayrollPackError(
      `AU Medicare levy variation declaration exemption answer "${medicareExemption}" is not a declared choice`,
    );
  }
  // PAYG prices the income leg AFTER pack-declared pre-tax treatments:
  // salary-sacrificed amounts reduce assessable income, so the withholding
  // is assessed on the reduced base. Superannuation guarantee prices
  // ordinary-time earnings, which salary sacrifice does NOT reduce — the
  // pensionable leg arrives whole and is passed through untouched.
  const paygIncome = reducedBases.income;
  const result = calculateAu2027({
    income: paygIncome,
    residency,
    workingHolidayMaker: bool(answers["working_holiday_maker"] ?? null),
    claimsThreshold: bool(answers["tax_free_threshold"] ?? null),
    medicareExemption,
    tfnQuoted: (answers["tax_file_number"] ?? "") !== "",
    stslDebt: bool(answers["stsl_debt"] ?? null),
    pensionable,
    periodsPerYear,
  });
  pushStatutory("payg_withholding", "deduction", "PAYG withholding", result.payg, 110);
  pushStatutory(
    "super_guarantee",
    "employer_contribution",
    "Superannuation guarantee",
    result.sg,
    210,
  );
  return { I: paygIncome, PI: pensionable };
}
