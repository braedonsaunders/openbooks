import { canonicalDecimal } from './exact-decimal'

/**
 * Single source of truth for item-rate numerics (PRC6). Rate quantities and
 * money amounts persist as numeric(19,4): at most 4 decimal places and at
 * most 15 whole-number digits. Both writers parse through here so a value
 * like "1.00005" is refused by name instead of silently rounding in
 * PostgreSQL (which would store 1.0001 while the API reports success).
 */
export const ITEM_RATE_DECIMAL_SCALE = 4
export const ITEM_RATE_WHOLE_DIGITS = 15

export type ItemRateDecimalError = 'not-a-number' | 'too-many-decimals' | 'too-wide'

function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

export function parseItemRateDecimal(value: unknown): { value: string } | { error: ItemRateDecimalError } {
  const text = String(value ?? '')
  // Parse wide first so excess precision is distinguishable from garbage:
  // canonicalDecimal caps the fraction it accepts, so parsing at the target
  // scale alone cannot tell "1.00005" from "abc".
  const wide = canonicalDecimal(text, 10)
  if (wide === null) return { error: 'not-a-number' }
  const fraction = wide.split('.')[1] ?? ''
  if (fraction.length > ITEM_RATE_DECIMAL_SCALE) return { error: 'too-many-decimals' }
  if (wholeDigits(wide) > ITEM_RATE_WHOLE_DIGITS) return { error: 'too-wide' }
  return { value: wide }
}
