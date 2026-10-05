/**
 * Exact-decimal helpers shared by payroll calculations. Amounts use bigint
 * units at 1e4 scale and rates use an exact 1e6 scale; no floating-point
 * arithmetic is used.
 */
import { PayrollError } from "./payroll-error.ts";
import { fromUnits, roundDiv, toUnits } from "./money.ts";

/** Money string → bigint units (1e4 scale). */
export const U = (s: string | number): bigint => toUnits(s);
/** bigint units → canonical numeric(19,4) string. */
export const D = (u: bigint): string => fromUnits(u);

const RATE6 = 1_000_000n;
const CENT = 100n; // cents quantum inside 1e4 units

/** Parse a decimal rate exactly, refusing malformed values and precision loss beyond six places. */
export function rate6(value: string | number): bigint {
  const raw = String(value).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) {
    throw new PayrollError(
      `not a decimal rate: "${value}" — enter a plain decimal without grouping separators or `
      + "exponent notation",
    );
  }
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[-+]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    throw new PayrollError(
      `rate loses precision beyond 6 decimal places: "${value}" — check the transcribed rate; `
      + "this parser accepts exact rates through six decimal places and never rounds",
    );
  }
  const units = BigInt(whole || "0") * RATE6 + BigInt((fraction + "000000").slice(0, 6));
  return negative ? -units : units;
}

/** Round units half-up (away from zero) to the cent. */
export function r2(u: bigint): bigint {
  return roundDiv(u, CENT) * CENT;
}

/** amount × rate, rounded half-up straight to the cent. */
export function mulRateCents(u: bigint, rate: string | number): bigint {
  return roundDiv(u * rate6(rate), RATE6 * CENT) * CENT;
}

/** amount × (num/den) with the ratio unrounded, result rounded to the cent. */
export function mulRatioCents(u: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new PayrollError("ratio denominator must be greater than zero");
  return roundDiv(u * num, den * CENT) * CENT;
}

/**
 * amount × rate kept at full unit precision (1e-4), for an intermediate that
 * is not itself withheld. Rounding such a value to the cent and then
 * annualizing it multiplies the rounding by the pay periods.
 */
export function mulRateUnits(u: bigint, rate: string | number): bigint {
  return roundDiv(u * rate6(rate), RATE6);
}

/** amount × (num/den) kept at full unit precision (1e-4); see mulRateUnits. */
export function mulRatioUnits(u: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new PayrollError("ratio denominator must be greater than zero");
  return roundDiv(u * num, den);
}

/** amount × integer (e.g. P × per-period amount) — exact, no rounding needed. */
export function mulInt(u: bigint, n: number): bigint {
  if (!Number.isInteger(n) || n < 0) throw new PayrollError(`not a non-negative integer: ${n}`);
  return u * BigInt(n);
}

/** amount ÷ integer, rounded half-up to the cent (annual → per-period). */
export function divIntCents(u: bigint, n: number): bigint {
  if (!Number.isInteger(n) || n <= 0) throw new PayrollError(`not a positive integer: ${n}`);
  return roundDiv(u, BigInt(n) * CENT) * CENT;
}

/** Truncate (drop, never round) sub-cent precision. */
export function truncCents(u: bigint): bigint {
  if (u < 0n) throw new PayrollError("truncCents expects a non-negative amount");
  return (u / CENT) * CENT;
}

export const max0 = (u: bigint): bigint => (u < 0n ? 0n : u);
export const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const bmax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
