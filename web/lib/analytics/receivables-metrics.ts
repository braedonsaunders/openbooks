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

/** Reasons are independent evidence, never an opaque composite score. */
export function collectionCustomerReasons(customer: {
  deteriorating: boolean; severe: string; failed: number; suppressed: number; missingTerms: string; held: boolean
  creditLimit?: string | null; committed?: string
}): ('deteriorating' | 'severe' | 'delivery' | 'terms' | 'held' | 'credit')[] {
  const reasons: ('deteriorating' | 'severe' | 'delivery' | 'terms' | 'held' | 'credit')[] = []
  if (customer.deteriorating) reasons.push('deteriorating')
  if (cmp(customer.severe, '0') > 0) reasons.push('severe')
  if (customer.failed > 0 || customer.suppressed > 0) reasons.push('delivery')
  if (cmp(customer.missingTerms, '0') > 0) reasons.push('terms')
  if (customer.held) reasons.push('held')
  if (customer.creditLimit != null && customer.committed !== undefined && cmp(customer.committed, customer.creditLimit) > 0) reasons.push('credit')
  return reasons
}

export class CollectionPeriodError extends Error {
  readonly status = 422
  readonly code = 'collection_period_in_future'
  constructor(message: string) { super(message); this.name = 'CollectionPeriodError' }
}

/** Missing observations never become zero-valued payments. Coordinates are
 * presentation values and do not participate in financial arithmetic. */
export function sparklineCoordinates(values: readonly (number | null)[]): { x: number; y: number }[] {
  const observed = values.flatMap((value, index) => value !== null && Number.isFinite(value) ? [{ value, index }] : [])
  if (observed.length < 2) return []
  const low = Math.min(...observed.map((p) => p.value)), high = Math.max(...observed.map((p) => p.value))
  return observed.map((p) => ({ x: 2 + p.index * 96 / Math.max(1, values.length - 1), y: high === low ? 16 : 28 - (p.value - low) * 24 / (high - low) }))
}
