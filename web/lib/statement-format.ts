// Presentation helpers for statement values — shared by the on-screen matrix
// table. Professional conventions: negatives in parentheses, a dash for zero,
// thousands separators, optional "in thousands / millions" scaling. (The PDF
// renderer has its own, stricter variant for currency-on-first-row rules.)
//
// Financial statement values are exact decimal STRINGS (numeric(19,4)), never
// JavaScript floats: the ledger is exact, so the reporting path that rolls the
// ledger up into statements must be exact too. All aggregation/scaling here is
// BigInt integer math on scaled minor units; binary floating point is only ever
// touched at the very end, inside Intl formatting, on a single already-rounded
// display value.

import type { ReportScale } from './report-filters'
import type { StatementColumnKind } from './statement-matrix'

export type ExactDecimal = string
export type StatementValue = ExactDecimal | null | undefined

const SCALE = 10_000n

export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be greater than zero')
  const negative = numerator < 0n
  const absolute = negative ? -numerator : numerator
  const rounded = (absolute + denominator / 2n) / denominator
  return negative ? -rounded : rounded
}

export function toDecimalUnits(value: string | number): bigint {
  let str = String(value).trim()
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(str)) throw new Error(`not a decimal number: "${value}"`)
  const neg = str.startsWith('-')
  str = str.replace(/^[-+]/, '')
  let exp = 0
  const em = str.match(/[eE]([-+]?\d+)$/)
  if (em) {
    exp = parseInt(em[1]!, 10)
    str = str.slice(0, em.index)
  }
  let [intPart, fracPart = ''] = str.split('.')
  if (exp > 0) {
    fracPart = fracPart.padEnd(exp, '0')
    intPart = intPart + fracPart.slice(0, exp)
    fracPart = fracPart.slice(exp)
  } else if (exp < 0) {
    intPart = intPart.padStart(-exp, '0')
    fracPart = intPart.slice(exp) + fracPart
    intPart = intPart.slice(0, exp) || '0'
  }
  if (fracPart.length > 4 && /[1-9]/.test(fracPart.slice(4))) throw new Error(`loses precision beyond 4 decimal places: "${value}"`)
  const frac = (fracPart + '0000').slice(0, 4)
  const units = BigInt(intPart || '0') * SCALE + BigInt(frac)
  return neg ? -units : units
}

export function fromDecimalUnits(units: bigint): ExactDecimal {
  const neg = units < 0n
  const abs = neg ? -units : units
  const int = abs / SCALE
  const frac = (abs % SCALE).toString().padStart(4, '0')
  return `${neg ? '-' : ''}${int}.${frac}`
}

export function decimalAdd(a: string, b: string): ExactDecimal {
  return fromDecimalUnits(toDecimalUnits(a) + toDecimalUnits(b))
}

export function decimalNeg(a: string): ExactDecimal {
  return fromDecimalUnits(-toDecimalUnits(a))
}

export function decimalSum(values: readonly string[]): ExactDecimal {
  return fromDecimalUnits(values.reduce((acc, value) => acc + toDecimalUnits(value), 0n))
}

export function decimalCmp(a: string, b: string): number {
  const diff = toDecimalUnits(a) - toDecimalUnits(b)
  return diff < 0n ? -1 : diff > 0n ? 1 : 0
}

export function decimalAbs(a: string): ExactDecimal {
  const units = toDecimalUnits(a)
  return fromDecimalUnits(units < 0n ? -units : units)
}

export function decimalIsZero(a: string): boolean {
  return toDecimalUnits(a) === 0n
}

/** True when |a| is at or above `threshold` (default half a cent) — the exact
 *  replacement for the old `Math.abs(v) >= 0.005` visibility test. */
export function decimalIsMaterial(a: string, threshold = '0.0050'): boolean {
  return decimalCmp(decimalAbs(a), threshold) >= 0
}

/** Divide an exact money value by an integer divisor (thousands/millions
 *  scaling), rounding half away from zero — no binary float division. */
export function decimalScale(value: string, divisor: number): ExactDecimal {
  if (!Number.isInteger(divisor) || divisor <= 0) throw new Error('divisor must be a positive integer')
  return fromDecimalUnits(roundDiv(toDecimalUnits(value), BigInt(divisor)))
}

/** Percent change (current vs prior) as an exact 4dp decimal, or null when the
 *  prior is zero (undefined variance). Kept exact so combined/derived totals
 *  never accumulate float error before display. */
export function decimalPercentChange(current: string, prior: string): ExactDecimal | null {
  const priorUnits = toDecimalUnits(prior)
  if (priorUnits === 0n) return null
  const diff = toDecimalUnits(current) - priorUnits
  const denominator = priorUnits < 0n ? -priorUnits : priorUnits
  return fromDecimalUnits(roundDiv(diff * 100n * SCALE, denominator))
}

/** Convert an exact decimal to a Number strictly for Intl formatting of a
 *  single already-rounded display cell (never for aggregation). */
export function decimalToNumber(value: StatementValue): number {
  return value === null || value === undefined ? NaN : Number(value)
}

export function scaleDivisor(scale: ReportScale): number {
  return scale === 'thousands' ? 1000 : scale === 'millions' ? 1_000_000 : 1
}

/** Whether a cell should read as "negative" for red-text styling. Accepts exact
 *  decimal strings (statement matrix) or numbers (legacy numeric reports). */
export function isNegative(value: StatementValue | number, kind: StatementColumnKind): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') {
    if (kind === 'variance_pct') return Number.isFinite(value) && value < 0
    return value < -0.005
  }
  if (kind === 'variance_pct') {
    const n = Number(value)
    return Number.isFinite(n) && n < 0
  }
  return decimalCmp(value, '-0.0050') <= 0
}
