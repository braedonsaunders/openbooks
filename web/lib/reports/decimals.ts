import {
  decimalAbs,
  decimalAdd,
  decimalCmp,
  decimalNeg,
  fromDecimalUnits,
  roundDiv,
  toDecimalUnits,
  type ExactDecimal,
} from "../statement-format";

export const ZERO: ExactDecimal = "0.0000";

export function decimalSubtract(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return decimalAdd(a, decimalNeg(b));
}

export function compareAbsoluteDescending(a: ExactDecimal, b: ExactDecimal): number {
  return decimalCmp(decimalAbs(b), decimalAbs(a));
}

export function decimalRatio(numerator: ExactDecimal, denominator: ExactDecimal): ExactDecimal | null {
  const denominatorUnits = toDecimalUnits(denominator);
  if (denominatorUnits === 0n) return null;
  const negative = denominatorUnits < 0n;
  const ratioUnits = roundDiv(toDecimalUnits(numerator) * 10_000n, negative ? -denominatorUnits : denominatorUnits);
  return fromDecimalUnits(negative ? -ratioUnits : ratioUnits);
}
