import { fromUnits, roundDiv, toUnits } from "./money.ts";

/**
 * Exact present-value arithmetic on BigInt rationals — no floating point.
 *
 * A per-period rate is an exact rational num/den (a 5% annual rate paid
 * monthly is exactly 5/(100·12) — never a truncated decimal), one discounting
 * step is multiplication by den/(den+num), and a payment stream is summed over
 * the common denominator (den+num)^T. The result is rounded to the ledger's
 * four decimals exactly once, at the end — the same "round once, at the ledger
 * boundary" discipline the rest of the engine uses.
 *
 * Used by lessee lease measurement (ASC 842-20-30-1 / IFRS 16.26) and by the
 * ASC 606 significant-financing-component split (606-10-32-15 / IFRS 15.60).
 */

const PERCENT_SCALE = 10_000_000_000n; // percent carried at 10dp

export class PresentValueError extends Error {
  readonly name = "PresentValueError";
}

/** An exact per-period rate num/den. */
export interface PeriodRate {
  num: bigint;
  den: bigint;
}

/** Parse an ANNUAL percent string ('5', '10.25') into the exact per-period
 *  rational for `periodsPerYear` payments a year. */
export function periodRateFromAnnualPercent(percent: string, periodsPerYear = 1): PeriodRate {
  const trimmed = percent.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new PresentValueError(`invalid rate percent: ${percent}`);
  }
  if (periodsPerYear <= 0) throw new PresentValueError("periodsPerYear must be positive");
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 10) {
    throw new PresentValueError("rate percent precision is limited to 10 decimal places");
  }
  const fracPadded = (frac + "0000000000").slice(0, 10);
  const percentUnits = BigInt(whole!) * PERCENT_SCALE + BigInt(fracPadded);
  // r_annual = percentUnits / (100 · 10^10); r_period = r_annual / periodsPerYear.
  return { num: percentUnits, den: 100n * PERCENT_SCALE * BigInt(periodsPerYear) };
}

export interface LevelPaymentStream {
  /** Payment per period, decimal money string. */
  payment: string;
  /** Number of periods. */
  periods: number;
  /** Exact per-period rate. */
  rate: PeriodRate;
  /** arrears = payments at period ends (ordinary annuity); advance = at starts. */
  timing: "arrears" | "advance";
}

/**
 * Present value of a level payment stream, exact to 4dp.
 *
 *   arrears:  PV = Σ_{t=1..T} P · s^t   where s = den/(den+num)
 *   advance:  PV = Σ_{t=0..T-1} P · s^t
 *
 * Computed as one rational over the common denominator (den+num)^T, rounded
 * half-up to money precision once.
 */
export function presentValueOfLevelStream(stream: LevelPaymentStream): string {
  const { periods, rate, timing } = stream;
  if (periods <= 0) throw new PresentValueError("periods must be positive");
  const paymentUnits = toUnits(stream.payment);
  if (paymentUnits <= 0n) throw new PresentValueError("payment must be positive");
  if (rate.num === 0n) return fromUnits(paymentUnits * BigInt(periods));

  const S = rate.den;
  const D = rate.den + rate.num;
  const pow = (base: bigint, exp: number): bigint => {
    let out = 1n;
    for (let i = 0; i < exp; i++) out *= base;
    return out;
  };
  const first = timing === "arrears" ? 1 : 0;
  const last = timing === "arrears" ? periods : periods - 1;
  let numerator = 0n;
  for (let t = first; t <= last; t++) {
    numerator += paymentUnits * pow(S, t) * pow(D, periods - t);
  }
  return fromUnits(roundDiv(numerator, pow(D, periods)));
}

/** Per-period interest at 4dp: round(balance × rate). */
export function periodInterest(balanceUnits: bigint, rate: PeriodRate): bigint {
  return roundDiv(balanceUnits * rate.num, rate.den);
}

export interface AccretionPeriod {
  sequence: number;
  opening: string;
  interest: string;
  payment: string;
  closing: string;
}

/**
 * Accrete a balance to zero across a level ARREARS payment stream: interest at
 * the period rate, payment against the balance, final period plugged so the
 * closing balance is EXACTLY zero. The plug absorbs cumulative 4dp rounding
 * and is asserted to sit within a cent per period of the computed interest —
 * a wider drift means the inputs are inconsistent, not a rounding artifact.
 */
export function accreteToZero(args: {
  opening: string;
  payment: string;
  periods: number;
  rate: PeriodRate;
}): AccretionPeriod[] {
  const { periods, rate } = args;
  if (periods <= 0) throw new PresentValueError("periods must be positive");
  const paymentUnits = toUnits(args.payment);
  const out: AccretionPeriod[] = [];
  let opening = toUnits(args.opening);
  for (let t = 1; t <= periods; t++) {
    let interest: bigint;
    let principal: bigint;
    if (t < periods) {
      interest = periodInterest(opening, rate);
      principal = paymentUnits - interest;
    } else {
      principal = opening;
      interest = paymentUnits - principal;
      const computed = periodInterest(opening, rate);
      const drift = interest - computed;
      const tolerance = BigInt(periods) * 100n; // one cent per period
      if (interest < 0n || drift > tolerance || -drift > tolerance) {
        throw new PresentValueError(
          `accretion does not close: final plug ${fromUnits(interest)} vs computed ${fromUnits(computed)}`,
        );
      }
    }
    const closing = opening - principal;
    out.push({
      sequence: t,
      opening: fromUnits(opening),
      interest: fromUnits(interest),
      payment: fromUnits(paymentUnits),
      closing: fromUnits(closing),
    });
    opening = closing;
  }
  if (opening !== 0n) {
    throw new PresentValueError(`accretion left a residual balance of ${fromUnits(opening)}`);
  }
  return out;
}
