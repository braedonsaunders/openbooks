/**
 * Exact-decimal helpers for the T4127 engine, built on money.ts bigint units
 * (1e4 scale). T4127 rounds "as each parenthesis is resolved", so every
 * multiplication here rounds half-up straight to the cent in one step —
 * never round-to-4dp-then-round-to-2dp, which double-rounds at the edge.
 */
import { fromUnits, roundDiv, toUnits } from "../../money";

/** Money string → bigint units (1e4 scale). */
export const U = (s: string | number): bigint => toUnits(s);
/** bigint units → canonical numeric(19,4) string. */
export const D = (u: bigint): string => fromUnits(u);

const RATE6 = 1_000_000n;
const CENT = 100n; // cents quantum inside 1e4 units

/** Parse a statutory rate (≤6 decimal places) to an exact 1e6-scaled bigint. */
export function rate6(value: string | number): bigint {
  const raw = String(value).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) throw new Error(`not a decimal rate: "${value}"`);
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[-+]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    throw new Error(`rate loses precision beyond 6 decimal places: "${value}"`);
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
  if (den <= 0n) throw new Error("ratio denominator must be greater than zero");
  return roundDiv(u * num, den * CENT) * CENT;
}

/** amount × integer (e.g. P × per-period amount) — exact, no rounding needed. */
export function mulInt(u: bigint, n: number): bigint {
  if (!Number.isInteger(n) || n < 0) throw new Error(`not a non-negative integer: ${n}`);
  return u * BigInt(n);
}

/** amount ÷ integer, rounded half-up to the cent (annual → per-period). */
export function divIntCents(u: bigint, n: number): bigint {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`not a positive integer: ${n}`);
  return roundDiv(u, BigInt(n) * CENT) * CENT;
}

/** Truncate (drop, never round) to the cent — CPP per-period exemption rule. */
export function truncCents(u: bigint): bigint {
  if (u < 0n) throw new Error("truncCents expects a non-negative amount");
  return (u / CENT) * CENT;
}

export const max0 = (u: bigint): bigint => (u < 0n ? 0n : u);
export const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const bmax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
