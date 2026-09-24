import { canonicalDecimal, divideDecimal, isPositiveDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
import { mulDecimal, neg, sum } from '@openbooks/engine/src/money/money.ts'

/** Return ROI as a one-decimal percentage string, using only exact decimals. */
export function equipmentRoiPercent(
  billedRevenue: string,
  recovery: string,
  directCosts: string,
  depreciation: string,
  purchasePrice: string,
): string {
  const purchase = canonicalDecimal(purchasePrice, 4)
  if (purchase === null || !isPositiveDecimal(purchase)) return '0.0'

  const netReturn = sum([
    billedRevenue,
    neg(recovery),
    neg(directCosts),
    neg(depreciation),
  ])
  return divideDecimal(mulDecimal(netReturn, '100'), purchase, 1)
}
