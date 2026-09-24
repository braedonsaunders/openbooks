import { cmp, normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal } from '../exact-decimal'

/** Canonical lease charge input; reject values that crossed a JS number first. */
export function canonicalPositiveLeaseCharge(value: unknown): string | null {
  const decimal = canonicalDecimal(value, 4)
  if (decimal === null) return null
  try {
    const amount = normalizeMoney(decimal)
    return cmp(amount, '0') > 0 ? amount : null
  } catch {
    return null
  }
}
