import { canonicalDecimal, compareDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'

/**
 * One-way projection for chart axes only. Ledger strings remain the source of
 * truth for every total, comparison, and decision; charts receive a finite,
 * bounded IEEE-754 value so a pathological numeric(19,4) cannot destabilize
 * the plotting library or leak a rounded value back into the model.
 */
export function boundChartNumber(value: number): number {
  const limit = Number.MAX_SAFE_INTEGER
  if (!Number.isFinite(value)) return value < 0 ? -limit : limit
  return Math.max(-limit, Math.min(limit, value))
}

export function toChartNumber(value: string): number {
  const exact = canonicalDecimal(value, 100)
  if (exact === null) throw new Error('chart values must be exact decimal strings')
  const limit = String(Number.MAX_SAFE_INTEGER)
  const comparison = compareDecimal(exact, limit)
  if (comparison > 0) return Number.MAX_SAFE_INTEGER
  if (compareDecimal(exact, `-${limit}`) < 0) return -Number.MAX_SAFE_INTEGER
  return boundChartNumber(Number(exact))
}

