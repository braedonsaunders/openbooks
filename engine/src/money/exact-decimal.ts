/** Exact decimal validation/comparison for request boundaries. Accounting
 * engines retain their own fixed-scale helpers; this module prevents API and
 * form coercion from crossing JavaScript's binary floating-point boundary. */

export function canonicalDecimal(value: unknown, maxScale = 4): string | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match || maxScale < 0 || (match[3]?.length ?? 0) > maxScale) return null;
  const negative = match[1] === "-";
  const whole = match[2]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const zero = /^0+$/.test(whole) && fraction === "";
  return `${negative && !zero ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
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

const EXACT_DECIMAL_RE = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/;

/** Cap exact scientific expansion so a hostile exponent cannot force a giant allocation. */
const MAX_EXACT_EXPONENT = 10_000;

function toScaled(value: string): { unscaled: bigint; scale: number } | null {
  const match = EXACT_DECIMAL_RE.exec(value.trim());
  if (!match) return null;
  const negative = match[1] === "-";
  const [intPart = "", fracPart = ""] = match[2]!.split(".");
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXACT_EXPONENT) return null;
  let digits = `${intPart}${fracPart}`.replace(/^0+/, "") || "0";
  let scale = fracPart.length - exponent;
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  const unscaled = BigInt(digits);
  return { unscaled: negative ? -unscaled : unscaled, scale };
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
