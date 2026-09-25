import { cmp, sum, toCents } from '@openbooks/engine/src/money/money.ts'
import { marginPercentText } from '../financial-decimal'

export { marginPercentText }

export function planTotalCost(lines: readonly { estAnnualCost: string }[]): string {
  const cents = toCents(sum(lines.map((line) => line.estAnnualCost)))
  const absolute = cents < 0n ? -cents : cents
  return `${cents < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`
}

export function ratePlacement(rate: string, min: string, max: string): 'below' | 'in_range' | 'above' {
  if (cmp(rate, min) < 0) return 'below'
  if (cmp(rate, max) > 0) return 'above'
  return 'in_range'
}
