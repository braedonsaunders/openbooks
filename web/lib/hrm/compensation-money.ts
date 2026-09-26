import { sum, toCents } from '@openbooks/engine/src/money/money.ts'
import { marginPercentText } from '../financial-decimal'

export { marginPercentText }

export function planTotalCost(lines: readonly { estAnnualCost: string }[]): string {
  const cents = toCents(sum(lines.map((line) => line.estAnnualCost)))
  const absolute = cents < 0n ? -cents : cents
  return `${cents < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`
}

