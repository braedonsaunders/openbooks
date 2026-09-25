import { roundDiv, toUnits } from '@openbooks/engine/src/money/money.ts'

/** Exact financial ratio rendered as a decimal percent with two places. */
export function marginPercentText(margin: string, revenue: string): string | null {
  const denominator = toUnits(revenue)
  if (denominator === 0n) return null
  const numerator = toUnits(margin) * 10_000n
  const negative = (numerator < 0n) !== (denominator < 0n)
  const cents = roundDiv(numerator < 0n ? -numerator : numerator, denominator < 0n ? -denominator : denominator)
  const whole = cents / 100n
  const fraction = (cents % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}
