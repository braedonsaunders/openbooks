import { canonicalPlainDecimal, parseExactDecimalParts } from "@openbooks/forms-core/decimals";

/** Exact decimal validation/comparison for request boundaries. Accounting
 * engines retain their own fixed-scale helpers; this module prevents API and
 * form coercion from crossing JavaScript's binary floating-point boundary. */

/** Financial boundaries require text and refuse scientific notation. */
export function canonicalDecimal(value: unknown, maxScale = 4): string | null {
  return canonicalPlainDecimal(value, maxScale);
}

/** The shared request grammar constrained to a non-negative exact value. */
export function canonicalNonNegativeDecimal(value: unknown, maxScale = 4): string | null {
  const canonical = canonicalDecimal(value, maxScale);
  return canonical === null || compareDecimal(canonical, "0") < 0 ? null : canonical;
}

function units(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const result =
    BigInt(whole || "0") * 10n ** BigInt(scale) +
    BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  return negative ? -result : result;
}

export function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const scale = Math.max(left.split(".")[1]?.length ?? 0, right.split(".")[1]?.length ?? 0);
  const difference = units(left, scale) - units(right, scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function isZeroDecimal(value: string): boolean {
  return compareDecimal(value, "0") === 0;
}

export function isPositiveDecimal(value: string): boolean {
  return compareDecimal(value, "0") > 0;
}

export function fixedDecimal(value: string, scale: number): string {
  const canonical = canonicalDecimal(value, scale);
  if (canonical == null) throw new Error("invalid decimal");
  const negative = canonical.startsWith("-");
  const [whole, fraction = ""] = canonical.replace(/^-/, "").split(".");
  return `${negative ? "-" : ""}${whole}.${fraction.padEnd(scale, "0")}`;
}

function toScaled(value: string): { unscaled: bigint; scale: number } | null {
  const parts = parseExactDecimalParts(value);
  return parts ? { unscaled: parts.units, scale: parts.scale } : null;
}

/**
 * Parse any finite decimal notation (plain or scientific) into an exact
 * plain-decimal string, or null when it is not one. Hex, Infinity, and NaN
 * are not decimal notations and are refused — never coerced through Number.
 */
export function parseExactDecimal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const scaled = toScaled(value);
  if (!scaled) return null;
  const negative = scaled.unscaled < 0n;
  const digits = (negative ? -scaled.unscaled : scaled.unscaled).toString();
  if (scaled.scale === 0) return `${negative && digits !== "0" ? "-" : ""}${digits}`;
  const padded = digits.padStart(scaled.scale + 1, "0");
  const whole = padded.slice(0, -scaled.scale);
  const fraction = padded.slice(-scaled.scale);
  return `${negative && !(whole === "0" && /^0+$/.test(fraction)) ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Exact decimal division rounded halves away from zero to `scale` places,
 * returned as a fixed-scale string. Inputs are validated exactly (no
 * Number crossing); a zero divisor or a non-decimal input throws instead
 * of producing Infinity, NaN, or a silently rounded float.
 */
export function divideDecimal(dividend: string, divisor: string, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) throw new Error("division scale must be an integer from 0 through 18");
  const left = toScaled(dividend);
  const right = toScaled(divisor);
  if (!left || !right) throw new Error(`not exact decimals: ${JSON.stringify(dividend)} / ${JSON.stringify(divisor)}`);
  if (right.unscaled === 0n) throw new Error(`cannot divide ${JSON.stringify(dividend)} by zero`);
  const numerator = left.unscaled * 10n ** BigInt(right.scale + scale);
  const denominator = right.unscaled * 10n ** BigInt(left.scale);
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const rounded = (absNumerator + absDenominator / 2n) / absDenominator;
  const digits = rounded.toString();
  const sign = negative && rounded !== 0n ? "-" : "";
  if (scale === 0) return `${sign}${digits}`;
  const padded = digits.padStart(scale + 1, "0");
  return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

/** Exact rate multiplication, rounded only at the caller's declared decimal scale. */
export function multiplyDecimal(left: string, right: string, scale: number): string {
  const a=toScaled(left),b=toScaled(right);
  if (!a || !b) throw new Error(`not exact decimal factors: ${JSON.stringify(left)}, ${JSON.stringify(right)}`);
  return divideDecimal((a.unscaled*b.unscaled).toString(),(10n ** BigInt(a.scale+b.scale)).toString(),scale);
}
