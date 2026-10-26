/**
 * Exact quantities for the cap table. Share counts are whole bigint shares.
 * Per-share prices (par value, issue, exercise and conversion prices, fair
 * values per unit) carry ten decimal places, matching numeric(28,10). Money
 * carries the ledger's four places. Percentages and multiples carry four.
 * Intermediate values are exact rationals; each result is quantized once,
 * at the scale its column stores, with the rounding rule its caller names.
 */
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
} from "../money/rational.ts";
import { equityError, fig } from "./errors.ts";
import type { EquityTermName } from "./refusals/terms.ts";

export type { Rational };
export {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
};

/** Decimal places of a stored per-share price. */
export const PRICE_SCALE = 10;
/** Decimal places of stored money. */
export const MONEY_SCALE = 4;
/** Decimal places of a stored percentage or multiple. */
export const PERCENT_SCALE = 4;

export const ZERO: Rational = rational(0n);
export const ONE: Rational = rational(1n);
const HUNDRED: Rational = rational(100n);

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a plain decimal string exactly. Scientific notation, blanks and
 * anything beyond `maxScale` places refuse by name: a value is never
 * coerced through a binary float or silently rounded on the way in.
 */
export function parseDecimal(value: unknown, label: EquityTermName, maxScale: number): Rational {
  const text =
    typeof value === "string" ? value.trim() : typeof value === "bigint" ? value.toString() : null;
  const match = text === null ? null : DECIMAL_RE.exec(text);
  if (!match)
    throw equityError("decimalInvalid", { label: fig.term(label), example: fig.decimal("1.25") });
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (fraction.length > maxScale)
    throw equityError("decimalPrecision", { label: fig.term(label), places: fig.count(maxScale) });
  const units = BigInt(`${match[2]}${fraction}`) * (match[1] ? -1n : 1n);
  return rational(units, 10n ** BigInt(fraction.length));
}

/** A required stored value; a missing one refuses instead of becoming zero. */
export function requireDecimal(
  value: string | null | undefined,
  label: EquityTermName,
  maxScale: number,
): Rational {
  if (value === null || value === undefined || value === "")
    throw equityError("valueMissing", { label: fig.term(label) });
  return parseDecimal(value, label, maxScale);
}

export const parsePrice = (value: unknown, label: EquityTermName): Rational =>
  parseDecimal(value, label, PRICE_SCALE);
export const parseMoney = (value: unknown, label: EquityTermName): Rational =>
  parseDecimal(value, label, MONEY_SCALE);

/** A percentage (0–100 with four places) as the fraction it denotes. */
export function parsePercent(value: unknown, label: EquityTermName): Rational {
  return divideRational(parseDecimal(value, label, PERCENT_SCALE), HUNDRED);
}

/** A whole, non-negative share count. */
export function parseShares(value: unknown, label: EquityTermName): bigint {
  const text =
    typeof value === "bigint" ? value.toString() : typeof value === "string" ? value.trim() : null;
  if (text === null || !/^\d+$/.test(text))
    throw equityError("sharesInvalid", { label: fig.term(label) });
  return BigInt(text);
}

export type RoundingRule = "half_up" | "floor" | "ceil";

/** Quantize a rational to an integer multiple of 10^-scale, returned as scaled units. */
export function quantize(value: Rational, scale: number, rule: RoundingRule): bigint {
  const numerator = value.numerator * 10n ** BigInt(scale);
  const denominator = value.denominator;
  const floor = floorDiv(numerator, denominator);
  if (rule === "floor") return floor;
  const remainder = numerator - floor * denominator;
  if (remainder === 0n) return floor;
  if (rule === "ceil") return floor + 1n;
  // Halves away from zero.
  const twice = remainder * 2n;
  if (numerator >= 0n) return twice >= denominator ? floor + 1n : floor;
  return twice > denominator ? floor + 1n : floor;
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator !== 0n && numerator < 0n !== denominator < 0n
    ? quotient - 1n
    : quotient;
}

/** Whole-share floor of a non-negative rational (fractions are paid in cash, never issued). */
export function floorShares(value: Rational): bigint {
  return floorDiv(value.numerator, value.denominator);
}

export function ceilShares(value: Rational): bigint {
  return -floorDiv(-value.numerator, value.denominator);
}

/** Render scaled units as a fixed-scale decimal string. */
export function formatUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export const formatPrice = (value: Rational, rule: RoundingRule = "half_up"): string =>
  formatUnits(quantize(value, PRICE_SCALE, rule), PRICE_SCALE);
export const formatMoney = (value: Rational, rule: RoundingRule = "half_up"): string =>
  formatUnits(quantize(value, MONEY_SCALE, rule), MONEY_SCALE);

/** A fraction rendered as a percentage with `scale` places (0.25 → "25.0000"). */
export function formatPercent(fraction: Rational, scale = PERCENT_SCALE): string {
  return formatUnits(quantize(multiplyRational(fraction, HUNDRED), scale, "half_up"), scale);
}

/**
 * An exact amount as ledger units (four places), rounded half up to the
 * currency's minor unit first: what a journal line for that currency carries.
 */
export function ledgerUnits(value: Rational, currencyExponent: number): bigint {
  return (
    quantize(value, currencyExponent, "half_up") * 10n ** BigInt(MONEY_SCALE - currencyExponent)
  );
}

/** Ledger units back to an exact rational. */
export const fromLedgerUnits = (units: bigint): Rational =>
  rational(units, 10n ** BigInt(MONEY_SCALE));

export const sharesRational = (shares: bigint): Rational => rational(shares);
export const isZero = (value: Rational): boolean => value.numerator === 0n;
export const isNegative = (value: Rational): boolean => value.numerator < 0n;
export const minRational = (a: Rational, b: Rational): Rational =>
  compareRational(a, b) <= 0 ? a : b;
export const maxRational = (a: Rational, b: Rational): Rational =>
  compareRational(a, b) >= 0 ? a : b;
export const sumRational = (values: readonly Rational[]): Rational =>
  values.reduce(addRational, ZERO);
export const bigMin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const bigMax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
