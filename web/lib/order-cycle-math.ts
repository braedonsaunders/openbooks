import { fromUnits, toUnits } from '@openbooks/engine/src/money.ts'

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('quantity cannot be zero')
  const negative = (numerator < 0n) !== (denominator < 0n)
  const top = numerator < 0n ? -numerator : numerator
  const bottom = denominator < 0n ? -denominator : denominator
  const rounded = (top + bottom / 2n) / bottom
  return negative ? -rounded : rounded
}

/** Exact numeric(19,4) remainder and proportional amount/tax for order conversion. */
export function remainingOrderLine(input: {
  quantity: string
  quantityBilled: string
  unitPrice: string
  taxAmount: string
}): { quantity: string; amount: string; taxAmount: string } | null {
  const original = toUnits(input.quantity)
  const remaining = original - toUnits(input.quantityBilled)
  if (remaining <= 0n) return null
  const amount = roundedDivide(remaining * toUnits(input.unitPrice), 10_000n)
  const tax = original === 0n ? 0n : roundedDivide(toUnits(input.taxAmount) * remaining, original)
  return { quantity: fromUnits(remaining), amount: fromUnits(amount), taxAmount: fromUnits(tax) }
}
