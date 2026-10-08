import { add, cmp, div } from '@openbooks/engine/money'

/** Positive collectible balances are the denominator; credits are exposed
 * separately so a credit cannot conceal an unpaid overdue invoice. */
export function receivablesRatio(numerator: string, denominator: string): string | null {
  return cmp(denominator, '0') > 0 ? div(numerator, denominator) : null
}

/** Contractual maturity, rather than an assertion of future collections. */
export function cumulativeReceivableMaturity(rows: readonly { gross: string }[]): string[] {
  let cumulative = '0.0000'
  return rows.map((row) => (cumulative = add(cumulative, row.gross)))
}
