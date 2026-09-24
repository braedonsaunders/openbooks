// Exact-decimal boundary helpers for the response validator and the formula
// evaluator. Bigint-only: an IEEE-754 double never crosses this module, so a
// submitted 0.30000000000000004 is measured as sixteen places (and refused
// over a 2-place scale) instead of being quietly rounded.
//
// The grammar mirrors engine/src/money/exact-decimal.ts (canonicalDecimal /
// parseExactDecimal), which this package cannot import: engine/src/flows
// imports forms-core, so the dependency must point the other way. Keep the
// two in lockstep — same acceptance grammar, same normalization.

/** An exact decimal as scaled units plus its scale (fraction digits). */
export type ExactDecimal = { units: bigint; scale: number }

const EXACT_DECIMAL_RE = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/

/** Cap exact scientific expansion so a hostile exponent cannot force a giant allocation. */
const MAX_EXACT_EXPONENT = 10_000

/**
 * Parse exact decimal text (plain or scientific) into scaled units, or null
 * when it is not one. Thousands separators, decimal commas, currency
 * symbols, hex, Infinity, and NaN are not decimal notations and are refused
 * — never coerced through Number.
 */
export function parseExactDecimalParts(raw: string): ExactDecimal | null {
  const match = EXACT_DECIMAL_RE.exec(raw.trim())
  if (!match) return null
  const negative = match[1] === '-'
  const [intPart = '', fracPart = ''] = match[2]!.split('.')
  const exponent = match[3] === undefined ? 0 : Number(match[3])
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXACT_EXPONENT) return null
  let digits = `${intPart}${fracPart}`.replace(/^0+/, '') || '0'
  let scale = fracPart.length - exponent
  if (scale < 0) {
    digits += '0'.repeat(-scale)
    scale = 0
  }
  const units = BigInt(digits)
  return { units: negative ? -units : units, scale }
}

/** Exact decimal content of a finite JS number ("1e-7" expands exactly). */
export function exactDecimalOfNumber(value: number): ExactDecimal | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return parseExactDecimalParts(String(value))
}

/** Render scaled units as canonical trimmed decimal text ("-0" becomes "0"). */
export function renderExactDecimal(units: bigint, scale: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString()
  if (scale === 0) return `${negative && digits !== '0' ? '-' : ''}${digits}`
  const padded = digits.padStart(scale + 1, '0')
  const whole = padded.slice(0, -scale).replace(/^0+(?=\d)/, '') || '0'
  const fraction = padded.slice(-scale).replace(/0+$/, '')
  const zero = whole === '0' && fraction === ''
  return `${negative && !zero ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/**
 * Normalize a submitted value to canonical exact-decimal text within
 * maxScale, or null. Strings must already be exact decimals; numbers are
 * measured through their exact expansion — a float whose expansion exceeds
 * the scale (0.30000000000000004 over 2 places) is refused, never rounded.
 */
export function canonicalDecimal(value: unknown, maxScale = 4): string | null {
  const parts =
    typeof value === 'number'
      ? exactDecimalOfNumber(value)
      : typeof value === 'string'
        ? parseExactDecimalParts(value)
        : null
  if (!parts || maxScale < 0 || parts.scale > maxScale) return null
  return renderExactDecimal(parts.units, parts.scale)
}

/** Exact comparison of two parsed decimals (no float crossing). */
export function compareExactDecimals(left: ExactDecimal, right: ExactDecimal): -1 | 0 | 1 {
  const difference = left.units * 10n ** BigInt(right.scale) - right.units * 10n ** BigInt(left.scale)
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}
