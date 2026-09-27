import { PayrollError } from "./error.ts";
import { apportion, fromUnits, roundDiv, toUnits } from "../money/money.ts";
import type { Money } from "../money/brands.ts";
/**
 * Exact `amount ÷ divisor`, rounded ONCE to `decimalPlaces`.
 *
 * Payroll divides money constantly — a salary by its periods, an annual rate
 * by its annual hours — and a reciprocal taken in binary floating point does
 * not survive the trip: `(1 / 1800).toFixed(10)` produces a factor whose
 * product with 125,000 is 69.4445 where the exact quotient is 69.4444, and
 * because that number IS the stored four-decimal hourly wage the error is
 * multiplied by every hour on every stub, always in the same direction. This
 * stays in BigInt from end to end (money.ts `roundDiv`) and rounds exactly
 * once, so no intermediate rounding can carry a half-cent across a boundary
 * either.
 */
export function divideMoney(amount: string, divisor: string, decimalPlaces = 4): Money {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 4) {
    throw new PayrollError("decimalPlaces must be an integer from 0 through 4");
  }
  const divisorUnits = toUnits(divisor);
  if (divisorUnits <= 0n) throw new PayrollError(`cannot divide pay by ${divisor}`);
  const quantum = 10n ** BigInt(4 - decimalPlaces);
  // fromUnits always emits fixed 4dp: the result is canonical Money.
  return fromUnits(roundDiv(toUnits(amount) * 10_000n, divisorUnits * quantum) * quantum) as Money;
}

/**
 * Split `amount` across weighted buckets so that the parts sum EXACTLY to it.
 *
 * Largest-remainder at cent precision: every bucket is floored to the cent
 * and the leftover whole cents go to the largest fractional remainders, ties
 * toward LATER buckets (so the historical "last bucket absorbs the remainder"
 * outputs are unchanged wherever they were already safe — 100/3 still ends
 * 33.33, 33.33, 33.34). Rounding each share independently instead let the
 * absorbed remainder flip a bucket negative (2c across four equal jobs ended
 * ..., +1c, -1c), which would land on the stub as a negative employer line;
 * it also paid rounding money to a zero-weight last bucket.
 *
 * Invariants: the parts sum exactly to `amount`; a zero weight always yields
 * zero (a job with no hours is never paid); every share keeps the amount's
 * sign; every share is within one cent of its exact proportional target.
 *
 * The split itself is the money kernel's `apportion` over whole cents with
 * ties to the later bucket; what this function adds is payroll's policy
 * around it: it throws on sub-cent dust instead of parking it, and a
 * negative weight means "emit one unsplit line". Collapsing the tie-break or
 * the dust rule would move cents between jobs.
 *
 * `amount` must be cent-exact (both call sites pass stub money already rounded
 * with `roundMoney(..., 2)` / `mulPercent(..., 2)`); a sub-cent input throws
 * `PayrollError` rather than silently misallocating, because parking the
 * sub-cent dust on one bucket can push it more than a cent from its target
 * (e.g. 1.90c over 19 equal buckets landed 1.90c on the last bucket whose
 * ideal share is 0.10c).
 *
 * Returns an empty array when the weights cannot carry an allocation (no
 * buckets, nothing to weight by, or a negative weight), which the callers read
 * as "emit one unsplit line". Allocating each part independently instead makes
 * a job-costed employer line disagree with the identically-computed employee
 * line by a cent purely because of how the hours happened to fall across jobs.
 */
export function allocateProportionally<T>(
  amount: string,
  buckets: readonly { weight: string; target: T }[],
): { amount: Money; target: T }[] {
  if (buckets.length === 0) return [];
  const weights: bigint[] = [];
  let totalWeight = 0n;
  for (const bucket of buckets) {
    const units = toUnits(bucket.weight);
    if (units < 0n) return [];
    weights.push(units);
    totalWeight += units;
  }
  if (totalWeight <= 0n) return [];
  // Money units are 1e-4: a cent is 100 of them.
  const amountUnits = toUnits(amount);
  if (amountUnits % 100n !== 0n) {
    throw new PayrollError(
      `allocateProportionally needs a cent-exact amount, got ${amount}`,
    );
  }
  const cents = apportion(amountUnits / 100n, weights, { residual: "largest_remainder_last" });
  return buckets.map((bucket, index) => ({
    // fromUnits always emits fixed 4dp: each share is canonical Money.
    amount: fromUnits(cents[index]! * 100n) as Money,
    target: bucket.target,
  }));
}
