import { fromUnits, normalizeDecimal, toUnits } from '@openbooks/engine/src/money.ts'

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

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('quantity cannot be zero')
  const negative = (numerator < 0n) !== (denominator < 0n)
  const top = numerator < 0n ? -numerator : numerator
  const bottom = denominator < 0n ? -denominator : denominator
  const rounded = (top + bottom / 2n) / bottom
  return negative ? -rounded : rounded
}

/** Exact eight-decimal quantity remainder and four-decimal amount/tax for order conversion. */
export function remainingOrderLine(input: {
  quantity: string
  quantityBilled: string
  unitPrice: string
  taxAmount: string
}): { quantity: string; amount: string; taxAmount: string } | null {
  const original = toQuantityUnits(input.quantity)
  const remaining = original - toQuantityUnits(input.quantityBilled)
  if (remaining <= 0n) return null
  // Quantity and unit price are both numeric(28,8), while the converted line
  // amount is ledger money (numeric(19,4)). Convert the exact product to money
  // units in one integer operation so neither operand is truncated to 4dp.
  const amount = roundedDivide(remaining * toQuantityUnits(input.unitPrice), 1_000_000_000_000n)
  const tax = original === 0n ? 0n : roundedDivide(toUnits(input.taxAmount) * remaining, original)
  return { quantity: fromQuantityUnits(remaining), amount: fromUnits(amount), taxAmount: fromUnits(tax) }
}

/**
 * Quantity headroom shared by order billing legs. Stock lines can only bill
 * received-and-unbilled quantity; service lines use the ordered remainder.
 */
export function billableRemainderQuantityUnits(input: {
  orderedQuantity: string
  billedQuantity: string
  fulfilledQuantity: string
  requiresReceipt: boolean
}): bigint {
  const remaining = toQuantityUnits(input.orderedQuantity) - toQuantityUnits(input.billedQuantity)
  if (remaining <= 0n) return 0n
  if (!input.requiresReceipt) return remaining
  const cover = toQuantityUnits(input.fulfilledQuantity) - toQuantityUnits(input.billedQuantity)
  if (cover <= 0n) return 0n
  return cover < remaining ? cover : remaining
}
