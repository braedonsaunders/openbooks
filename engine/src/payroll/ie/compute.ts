/**
 * Ireland 2026 statutory engine — pure, no database, no clock.
 *
 * Implements the employer's operating instructions on revenue.ie (the pages
 * that tell employers what they MUST do — normative), cross-checked against
 * DSP's SW14 and advance notices for PRSI:
 *
 * PAYE (cumulative and week-1/month-1):
 * - "Cumulative tax is the tax due on an employee's total income from
 *   1 January to the current date. The tax due for any pay period is the
 *   cumulative tax payable less the tax already deducted during that year."
 *   (…/methods-of-calculating-tax/cumulative-basis.aspx)
 * - "To calculate weekly tax credits and rate band divide the figures
 *   provided on the RPN by 52. For fortnightly, divide each figure by 26
 *   and for monthly, divide by 12." (same page)
 * - "The Week 1 basis or Month 1 basis … is also known as 'non-cumulative
 *   basis'." / "Employers must tax each pay day on its own, separate from
 *   previous weeks." (…/week1-basis.aspx)
 * - "In week 3 you do not refund any tax to Ann, even though she has not
 *   used all of her tax credits for that week. This is because she is on a
 *   week 1 basis." (same page — week-1 never refunds; cumulative does:
 *   "When tax is operated on a cumulative basis, an employee is sometimes
 *   entitled to a tax refund.")
 * - "Employers must operate Emergency Tax when no Revenue Payroll
 *   Notification (RPN) is available." (…/emergency-basis.aspx) — no RPN is
 *   a named refusal here, never an approximation.
 * - "An employer should only apply a tax exemption if they are instructed
 *   to do so on the employee's Revenue Payroll Notification (RPN). Where
 *   tax exemption applies … the employee is given a special amount cut-off
 *   point and tax credit on their RPN. The higher rate of tax to be applied
 *   is the marginal relief rate of 40%." (…/tax-exemption-marginal-relief.
 *   aspx) — exemption/marginal relief needs NO separate engine path: the
 *   RPN figures flow through the same arithmetic at the same 40% rate.
 *
 * Convention the worked examples pin down (see conformance tests): the
 * apportioned rate band rounds UP to the cent (Mark: €44,000/52 shows
 * €846.16; Ann: same; Sarah: €53,000/52 shows €1,019.24), apportioned tax
 * credits round half-up (€4,000/52 shows €76.92 on both employer pages),
 * and each rate product rounds half-up (€846.16 at 20% shows €169.23;
 * €3.84 at 40% shows €1.54). Cumulative figures scale the SAME way:
 * Fiona week 26 shows "(€44,000 / 52 weeks x 26 weeks = €22,000)" and
 * "(€4,000 / 52 weeks x 26 weeks = €2,000)".
 *
 * PRSI (week-one, never cumulative): rates and bands from rates.ts; the AX
 * credit formula and the fortnightly/monthly bands are quoted there.
 *
 * USC (cumulative, like PAYE): standard bands from rates.ts applied to the
 * RPN's cut-off points. The €13,000 exemption is RPN-delivered (uscExempt):
 * the floor is Revenue's annual reconciliation ("you pay USC on your full
 * income" once over it), not an in-year test. Reduced USC (70+/
 * medical-card) refuses by name: the engine has no qualifying-status input
 * and standard rates on a reduced-rate employee would be wrong money.
 *
 * KNOWN AUTHORITY INCONSISTENCIES (all quoted in rates.ts / tests, none
 * silently absorbed):
 * - The employee explainer page shows weekly credits €76.93 and monthly
 *   €333.34 where the two employer instruction pages show €76.92 (both
 *   divide €4,000 the same way). The engine follows the employer
 *   instruction. Ruth's monthly payable therefore computes €533.33 against
 *   the explainer's €533.32 — a 1c documented divergence.
 * - DSP's Employer Guide four-week table prints employee charges €17.47
 *   (€426 AL) and €22.02 (€557 A1), irreproducible at the stated 4.2%
 *   (17.89 / 23.39). Recorded as authority errata; not encoded.
 * - DSP's SW14 illustrative table prints 4.2%-column €16.60 (€395) and
 *   €17.80 (€424) where exact arithmetic gives €16.59 / €17.81. Same
 *   treatment.
 *
 * Money discipline: decimal strings at 1e4 scale in and out ("254.8300"),
 * never floats. Rounding helpers mirror engine/src/payroll/canada/
 * decimal.ts and are built on engine/src/money.ts only.
 */
import { fromUnits, roundDiv, toUnits } from "../../money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import {
  prsiPeriodBands,
  ratesForPayDate,
  type IeEditionRates,
} from "./rates.ts";

/** Money string → bigint units (1e4 scale). */
const U = (s: string | number): bigint => toUnits(s);
/** bigint units → canonical numeric(19,4) string. */
const D = (u: bigint): string => fromUnits(u);

/** Round units half-up (halves away from zero) to the cent. */
function r2(u: bigint): bigint {
  return roundDiv(u, 100n) * 100n;
}

/** Ceiling to the cent (for apportioned rate bands/cut-offs). */
function ceil2(u: bigint): bigint {
  if (u < 0n) throw new PayrollPackError("IE payroll: negative amount has no ceiling rule");
  return ((u + 99n) / 100n) * 100n;
}

const RATE6 = 1_000_000n;

/** Parse a rate (≤6 dp) to an exact 1e6-scaled bigint. */
function rate6(value: string): bigint {
  const raw = value.trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(raw)) {
    throw new PayrollPackError(`IE payroll: not a decimal rate: "${value}"`);
  }
  const [whole = "0", fraction = ""] = raw.split(".");
  return BigInt(whole || "0") * RATE6 + BigInt((fraction + "000000").slice(0, 6));
}

/** amount × rate, rounded half-up straight to the cent. */
function mulRateCents(u: bigint, rate: string): bigint {
  return roundDiv(u * rate6(rate), RATE6 * 100n) * 100n;
}

/** amount × (num/den) with the ratio unrounded, result half-up to the cent. */
function mulRatioCents(u: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new PayrollPackError("IE payroll: ratio denominator must be positive");
  return roundDiv(u * num, den * 100n) * 100n;
}

function max0(u: bigint): bigint {
  return u < 0n ? 0n : u;
}

export type IePayBasis = "cumulative" | "week1";

export interface IeStatutoryInput {
  /** Pay date: gates the edition (throws outside calendar 2026). */
  payDate: string;
  /** 12 (monthly), 13 (four-weekly), 26 (fortnightly) or 52 (weekly). */
  periodsPerYear: number;
  /** RPN basis. Week-1/Month-1 never refunds; cumulative may. */
  basis: IePayBasis;
  /** False when no RPN exists → emergency-basis named refusal. */
  hasRpn: boolean;
  /** RPN total annual tax credits (personal + PAYE + any others). */
  taxCreditsAnnual: string;
  /** RPN annual standard-rate cut-off (special figure under exemption). */
  rateBandAnnual: string;
  /** This period's taxable pay (gross less ordinary pension contributions). */
  taxablePayPeriod: string;
  /** Prior cumulative taxable pay this year (0 on week-1 / first period). */
  taxablePayYtd: string;
  /** Tax already deducted this year (0 on week-1 / first period). */
  taxPaidYtd: string;
  /** This period's reckonable pay (gross; pensions give no PRSI relief). */
  reckonablePayPeriod: string;
  /** Prior cumulative gross pay this year (USC cliff base). */
  grossPayYtd: string;
  /** USC already deducted this year. */
  uscPaidYtd: string;
  /** RPN states USC exemption (e.g. income at/below the €13,000 floor). */
  uscExempt: boolean;
  /** 70+/medical-card reduced rates — refused by name (no status input). */
  uscReducedEligible: boolean;
  /**
   * Periods elapsed including this pay (1-based, ≤ periodsPerYear):
   * Income Tax week/month number on the cumulative basis; 1 on week-1.
   */
  elapsedPeriods: number;
}

export interface IeStatutoryResult {
  /** This period's PAYE (negative on a cumulative refund). */
  paye: string;
  /** This period's employee PRSI (≥ 0). */
  prsiEmployee: string;
  /** This period's employer PRSI (≥ 0). */
  prsiEmployer: string;
  /** This period's USC (negative only on a cumulative USC refund). */
  usc: string;
  /** PRSI subclass applied (A0/AX/AL/A1). */
  prsiSubclass: string;
  /** Edition stamp that computed this stub. */
  edition: string;
}

const SUPPORTED_FREQUENCIES = [12, 13, 26, 52] as const;

function fail(message: string): never {
  throw new PayrollPackError(`IE payroll: ${message}`);
}

function parseMoney(value: string, what: string): bigint {
  try {
    return U(value);
  } catch {
    fail(`${what} is not a money amount: "${value}"`);
  }
}

/** Income Tax week number (1-based) for a pay date: week 1 is 1–7 January. */
export function ieWeekNumber(payDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(payDate);
  if (!m) fail(`pay date is not an ISO date: "${payDate}"`);
  const start = Date.UTC(Number(m![1]), 0, 1);
  const day = Date.UTC(Number(m![1]), Number(m![2]) - 1, Number(m![3]));
  const diff = Math.floor((day - start) / 86_400_000);
  if (diff < 0) fail(`pay date ${payDate} is outside its tax year`);
  return Math.floor(diff / 7) + 1;
}

function payePass(
  edition: IeEditionRates,
  periodsPerYear: number,
  elapsedPeriods: number,
  creditsAnnual: bigint,
  bandAnnual: bigint,
  cumulativeTaxablePay: bigint,
): { grossTax: bigint; credits: bigint; cutoff: bigint } {
  const p = BigInt(periodsPerYear);
  const n = BigInt(elapsedPeriods);
  // Fiona: "(€44,000 / 52 weeks x 26 weeks = €22,000)" — scale annual × n/P.
  const cutoff = ceil2(roundDiv(bandAnnual * n, p));
  const credits = r2(roundDiv(creditsAnnual * n, p));
  const standardBase = cumulativeTaxablePay < cutoff ? cumulativeTaxablePay : cutoff;
  const higherBase = max0(cumulativeTaxablePay - cutoff);
  const grossTax =
    mulRateCents(standardBase, edition.payeStandardRate) +
    mulRateCents(higherBase, edition.payeHigherRate);
  return { grossTax, credits, cutoff };
}

function uscPass(
  edition: IeEditionRates,
  periodsPerYear: number,
  elapsedPeriods: number,
  cumulativeGrossPay: bigint,
): bigint {
  // No in-year exemption-floor test: the employer applies the RPN's USC
  // cut-off points ("This will tell you what USC rates and cut-off points
  // to apply"), and the €13,000 floor arrives as the RPN's USC exemption
  // (reconciled by Revenue at year-end). Testing the floor in-engine would
  // under-deduct USC for most of the year and then catch up in one leap.
  const p = BigInt(periodsPerYear);
  const n = BigInt(elapsedPeriods);
  let remaining = cumulativeGrossPay;
  let charge = 0n;
  for (const band of edition.uscBands) {
    if (remaining <= 0n) break;
    // Widths scale like cut-offs (ceiling, same convention as PAYE bands).
    const width = band.width === null ? null : ceil2(roundDiv(U(band.width) * n, p));
    const base = width === null || remaining < width ? remaining : width;
    charge += mulRateCents(base, band.rate);
    remaining -= base;
  }
  return charge;
}

function prsiPass(
  edition: IeEditionRates,
  periodsPerYear: 12 | 26 | 52,
  reckonablePay: bigint,
): { employee: bigint; employer: bigint; subclass: string } {
  if (reckonablePay < 0n) fail("reckonable pay is negative");
  const bands =
    periodsPerYear === 52
      ? prsiPeriodBands().weekly
      : periodsPerYear === 26
        ? prsiPeriodBands().fortnightly
        : prsiPeriodBands().monthly;
  const a0Max = U(bands.a0Max);
  const axMax = U(bands.axMax);
  const alMax = U(bands.alMax);
  // Below €38 a week is PRSI Class J, not Class A — the guidelines put
  // "reckonable income … less than €38 per week" in Class J, whose employer
  // rate differs — so sub-floor pay is refused by name.
  if (periodsPerYear === 52 && reckonablePay < U("38")) {
    fail("weekly pay below €38 is PRSI Class J, not Class A — refused by name");
  }
  if (periodsPerYear !== 52 && reckonablePay < U(periodsPerYear === 26 ? "76" : "165")) {
    fail(
      "fortnightly/monthly pay below the published A0 floor needs the " +
        "€38-a-week Class J proviso — refused by name",
    );
  }
  if (reckonablePay <= a0Max) {
    // A0: employee Nil, employer lower rate on all reckonable pay.
    return {
      employee: 0n,
      employer: mulRateCents(reckonablePay, edition.prsiEmployerLowerRate),
      subclass: "A0",
    };
  }
  const employerRate =
    reckonablePay <= alMax ? edition.prsiEmployerLowerRate : edition.prsiEmployerHigherRate;
  if (reckonablePay <= axMax) {
    if (periodsPerYear === 12) {
      fail(
        "monthly pay in the AX band needs the weekly PRSI Credit, which DSP " +
          "publishes no monthly equivalent for — refused by name",
      );
    }
    // Fortnightly pay covers exactly two weeks ("each week worked during
    // that fortnight"): split and charge each week. Weekly: charge directly.
    const weeks = periodsPerYear === 26 ? 2 : 1;
    const weeklyPay = reckonablePay / BigInt(weeks);
    const remainder = reckonablePay % BigInt(weeks);
    let employee = 0n;
    for (let w = 0; w < weeks; w++) {
      // Odd cent amounts split half-cent-exact; the extra 0.5 unit lands on
      // the first week. Sub-cent precision survives: products round once.
      const slice = weeklyPay + (w === 0 ? remainder : 0n);
      const gross = mulRateCents(slice, edition.prsiEmployeeRate);
      // "Reduced by one sixth of earnings in excess of €352.01": the sixth
      // rounds half-up to the cent (SW14: 24.99 ÷ 6 shows €4.17) and the
      // credit is the €12 maximum less that rounded sixth (12.00 − 4.17 =
      // €7.83 in the same example). The maximum caps short excess, which
      // only fortnightly half-weeks can produce.
      const excess = slice - U(edition.prsiCreditBase);
      const sixth = mulRatioCents(excess < 0n ? 0n : excess, 1n, 6n);
      const credit = max0(U(edition.prsiCreditMax) - sixth);
      employee += max0(gross - credit);
    }
    return {
      employee,
      employer: mulRateCents(reckonablePay, employerRate),
      subclass: "AX",
    };
  }
  return {
    employee: mulRateCents(reckonablePay, edition.prsiEmployeeRate),
    employer: mulRateCents(reckonablePay, employerRate),
    subclass: reckonablePay <= alMax ? "AL" : "A1",
  };
}

export function calculateIeStatutory(input: IeStatutoryInput): IeStatutoryResult {
  const edition = ratesForPayDate(input.payDate);
  if (!(SUPPORTED_FREQUENCIES as readonly number[]).includes(input.periodsPerYear)) {
    fail(
      `pay frequency ${input.periodsPerYear}/year is not implemented ` +
        "(weekly, fortnightly, four-weekly and monthly only) — refused by name",
    );
  }
  if (!input.hasRpn) {
    fail(
      "no Revenue Payroll Notification — Emergency Tax applies " +
        "(Revenue: 'Employers must operate Emergency Tax when no Revenue " +
        "Payroll Notification (RPN) is available'); emergency-basis figures " +
        "live in 'Emergency Basis of Tax Deduction' and are refused by name",
    );
  }
  if (input.uscReducedEligible) {
    fail(
      "reduced USC (70+/medical-card) eligibility is not modelled — " +
        "standard bands on a reduced-rate employee would be wrong money",
    );
  }
  if (!Number.isInteger(input.elapsedPeriods) || input.elapsedPeriods < 1) {
    fail(`elapsed periods must be a positive integer, got ${input.elapsedPeriods}`);
  }
  if (input.basis === "week1" && input.elapsedPeriods !== 1) {
    fail("week-1/month-1 basis taxes each pay day on its own (elapsed periods must be 1)");
  }
  if (input.elapsedPeriods > input.periodsPerYear) {
    fail(`elapsed periods ${input.elapsedPeriods} exceed ${input.periodsPerYear}/year`);
  }
  const creditsAnnual = parseMoney(input.taxCreditsAnnual, "tax credits");
  const bandAnnual = parseMoney(input.rateBandAnnual, "rate band");
  const payPeriod = parseMoney(input.taxablePayPeriod, "period taxable pay");
  const payYtd = parseMoney(input.taxablePayYtd, "cumulative taxable pay");
  const taxYtd = parseMoney(input.taxPaidYtd, "tax paid");
  const reckonable = parseMoney(input.reckonablePayPeriod, "reckonable pay");
  const grossYtd = parseMoney(input.grossPayYtd, "cumulative gross pay");
  const uscYtd = parseMoney(input.uscPaidYtd, "USC paid");
  if (creditsAnnual < 0n || bandAnnual < 0n) fail("RPN credits and band must be non-negative");
  if (payPeriod < 0n || payYtd < 0n || reckonable < 0n || grossYtd < 0n) {
    fail("pay inputs must be non-negative");
  }

  // PAYE — cumulative figures, then the period's share.
  const cumulativeTaxable = payYtd + payPeriod;
  const pass = payePass(
    edition,
    input.periodsPerYear,
    input.elapsedPeriods,
    creditsAnnual,
    bandAnnual,
    cumulativeTaxable,
  );
  const cumulativePayable = max0(pass.grossTax - pass.credits);
  const paye =
    input.basis === "cumulative"
      ? cumulativePayable - taxYtd // may be negative: the cumulative refund
      : max0(pass.grossTax - pass.credits); // week-1 never refunds

  // USC — same cumulative shape over gross pay; the exemption flag wins.
  let usc: bigint;
  if (input.uscExempt) {
    usc = 0n;
  } else {
    const cumulativeGross = grossYtd + reckonable;
    const cumulativeUsc = uscPass(edition, input.periodsPerYear, input.elapsedPeriods, cumulativeGross);
    usc =
      input.basis === "cumulative" ? cumulativeUsc - uscYtd : max0(cumulativeUsc - uscYtd);
  }

  // PRSI — week-one on this period only. Four-weekly payrolls have no
  // published PRSI bands, so PRSI refuses P=13 while PAYE/USC compute.
  let prsi = { employee: 0n, employer: 0n, subclass: "A0" };
  if (input.periodsPerYear === 13) {
    fail(
      "four-weekly PRSI has no published bands (DSP publishes weekly, " +
        "fortnightly and monthly only) — refused by name",
    );
  } else {
    prsi = prsiPass(edition, input.periodsPerYear as 12 | 26 | 52, reckonable);
  }

  return {
    paye: D(paye),
    prsiEmployee: D(prsi.employee),
    prsiEmployer: D(prsi.employer),
    usc: D(usc),
    prsiSubclass: prsi.subclass,
    edition: edition.edition,
  };
}
