import { cmp, roundDiv, toUnits } from '@openbooks/engine/src/money/money.ts'

/** Maximum magnitude passed to chart libraries for a monetary axis value. */
export const MAX_FINANCIAL_CHART_COORDINATE = 1_000_000_000

/**
 * Convert exact decimal text to a bounded visual coordinate. This is only for
 * chart geometry; retain and format the original decimal string everywhere
 * that represents a monetary amount or participates in financial arithmetic.
 */
export function financialChartCoordinate(value: string): number {
  const bound = String(MAX_FINANCIAL_CHART_COORDINATE)
  if (cmp(value, bound) > 0) return MAX_FINANCIAL_CHART_COORDINATE
  if (cmp(value, `-${bound}`) < 0) return -MAX_FINANCIAL_CHART_COORDINATE
  return Number(value)
}

/** Compute a 0..100 chart percentage with exact inputs and bounded output. */
export function financialChartPercent(value: string, denominator: string): number {
  if (cmp(denominator, '0') <= 0 || cmp(value, '0') <= 0) return 0
  if (cmp(value, denominator) >= 0) return 100
  const basisPoints = roundDiv(toUnits(value) * 10_000n, toUnits(denominator))
  return Number(basisPoints) / 100
}
