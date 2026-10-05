import { currencyMinorUnits } from '../../../../lib/iso-currencies'

/**
 * A label cost in minor units as the exact major-unit decimal the money
 * formatter takes. String arithmetic only: label costs cross through here
 * as BigInt-scale integers, and a float would round a large carrier invoice
 * line. Null when the stored value is not an integer at all — a wrong
 * amount must never render as a confident one.
 */
export function minorToMajor(minor: string, currency: string): string | null {
  if (!/^-?\d+$/.test(minor)) return null
  const exponent = currencyMinorUnits(currency)
  const negative = minor.startsWith('-')
  const digits = (negative ? minor.slice(1) : minor).replace(/^0+(?=\d)/, '')
  if (exponent === 0) return `${negative ? '-' : ''}${digits}`
  const padded = digits.padStart(exponent + 1, '0')
  const whole = padded.slice(0, -exponent) || '0'
  return `${negative ? '-' : ''}${whole}.${padded.slice(-exponent)}`
}

/**
 * Exact sum of two non-negative rate decimals for bulk totals. String
 * arithmetic only: forty label amounts must total to the cent the journal
 * will post. Null for anything that is not a plain non-negative decimal —
 * a total must never silently absorb garbage.
 */
export function addExact(left: string, right: string): string | null {
  const valid = (value: string): string[] | null => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value)
    return match ? [match[1]!, match[2] ?? ''] : null
  }
  const a = valid(left)
  const b = valid(right)
  if (!a || !b) return null
  const width = Math.max(a[1]!.length, b[1]!.length)
  const sum = BigInt(a[0]! + a[1]!.padEnd(width, '0')) + BigInt(b[0]! + b[1]!.padEnd(width, '0'))
  const text = sum.toString().padStart(width + 1, '0')
  if (width === 0) return text
  return `${text.slice(0, -width) || '0'}.${text.slice(-width)}`
}
