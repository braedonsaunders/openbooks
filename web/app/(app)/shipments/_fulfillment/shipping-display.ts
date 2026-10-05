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
