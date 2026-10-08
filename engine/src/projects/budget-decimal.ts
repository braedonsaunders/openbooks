import { fromUnits, normalizeDecimal, roundDiv } from "../money/money.ts";

/**
 * Exact eight-decimal arithmetic for budget hours and production quantities
 * (numeric(28,8)). Money stays in the ledger's four-decimal helpers; these
 * quantities keep their commercial precision until a four-decimal column
 * stores them.
 */

const SCALE = 100_000_000n;

export function decimal8Units(value: string): bigint {
  const n = normalizeDecimal(value, 8);
  const negative = n.startsWith("-");
  const [whole = "0", fraction = ""] = n.replace(/^-/, "").split(".");
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
  return negative ? -units : units;
}

export function fromDecimal8Units(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  return `${negative ? "-" : ""}${abs / SCALE}.${(abs % SCALE).toString().padStart(8, "0")}`;
}

export function sumDecimal8(values: readonly string[]): string {
  return fromDecimal8Units(values.reduce((acc, value) => acc + decimal8Units(value), 0n));
}

/** Round an eight-decimal quantity half away from zero to four decimals. */
export function decimal8ToFour(units: bigint): string {
  return fromUnits(roundDiv(units, 10_000n));
}
