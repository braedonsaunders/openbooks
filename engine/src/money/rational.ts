import { roundDiv } from './money.ts';

/** Exact intermediate values; quantization belongs at the domain's declared boundary. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export const RATIONAL_DIGITS = 256;

export class RationalError extends Error {
  readonly name = 'RationalError';
  constructor(readonly code: 'DIVISION_BY_ZERO' | 'LIMIT', message: string) {
    super(message);
  }
}

function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b;
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new RationalError('DIVISION_BY_ZERO', 'Exact arithmetic requires a nonzero divisor.');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  if (numerator.toString().length > RATIONAL_DIGITS || denominator.toString().length > RATIONAL_DIGITS) {
    throw new RationalError('LIMIT', 'Exact arithmetic exceeds the supported intermediate-value limit.');
  }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

export function compareRational(a: Rational, b: Rational): -1 | 0 | 1 {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function addRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

export function subtractRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}

export function divideRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}

/** Round to an integral quantum, halves away from zero. */
export function roundRational(value: Rational, quantum = 1n): bigint {
  if (quantum <= 0n) throw new Error('Exact arithmetic requires a positive rounding quantum.');
  return roundDiv(value.numerator, value.denominator * quantum) * quantum;
}
