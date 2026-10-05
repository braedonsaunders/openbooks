import { canonicalDecimal } from '@openbooks/engine/money/decimal'

/**
 * Exact conversions between operator majors ("120.50") and storage minors
 * (12050) for setup `money` fields, keyed by the currency's minor-unit
 * precision. Parsing composes the shared decimal grammar, so every refusal
 * remedy (decimal commas, ambiguous commas, separators, scale) comes from
 * the single classifier in the engine money module — never a second one
 * here. The arithmetic below is pure decimal-string math, never floats.
 */

export function minorToMajor(minor: string | number | bigint, exponent: number): string | null {
  let units: bigint
  try {
    units = typeof minor === 'bigint' ? minor : BigInt(String(minor).trim())
  } catch {
    return null
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) return null
  const negative = units < 0n
  const digits = (negative ? -units : units).toString()
  if (exponent === 0) return `${negative ? '-' : ''}${digits}`
  const padded = digits.padStart(exponent + 1, '0')
  const head = padded.slice(0, -exponent)
  const tail = padded.slice(-exponent)
  return `${negative ? '-' : ''}${head}.${tail}`
}

/**
 * Operator majors to storage minors. Returns null for anything the shared
 * grammar refuses; the caller renders the classifier's precise remedy
 * (decimalNullRefusal/moneyRefusal) instead of inventing advice here.
 */
export function majorToMinor(major: string, exponent: number): string | null {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) return null
  const canonical = canonicalDecimal(major, exponent)
  if (canonical == null) return null
  const negative = canonical.startsWith('-')
  const [whole, fraction = ''] = canonical.replace(/^[+-]/, '').split('.')
  const minor = BigInt(whole || '0') * 10n ** BigInt(exponent) + BigInt((fraction + '0'.repeat(exponent)).slice(0, exponent) || '0')
  return (negative ? '-' : '') + minor.toString()
}
