import {normalizeDecimal} from './money.ts'

/** Commercial quantities use the eight decimal places of document_lines. */
export const QUANTITY_SCALE = 100_000_000n

/** Parse a numeric(28,8) quantity without crossing the floating-point boundary. */
export function toQuantityUnits(value: string | number): bigint {
  const normalized = normalizeDecimal(value, 8)
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const units = BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(8, '0'))
  return negative ? -units : units
}

/** Format a quantity with at least four and up to eight significant decimals. */
export function fromQuantityUnits(units: bigint): string {
  const negative = units < 0n
  const absolute = negative ? -units : units
  const whole = absolute / QUANTITY_SCALE
  const fraction = (absolute % QUANTITY_SCALE).toString().padStart(8, '0')
  const trimmed = fraction.replace(/0+$/, '')
  const displayedFraction = trimmed.length < 4 ? fraction.slice(0, 4) : trimmed
  return `${negative ? '-' : ''}${whole}.${displayedFraction}`
}
