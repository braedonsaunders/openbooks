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
