/**
 * US economic-nexus tracking (post-Wayfair).
 *
 * Since South Dakota v. Wayfair (2018), a seller owes sales tax in a state once
 * it crosses that state's economic threshold — a dollar amount of sales and/or a
 * transaction count over a measurement window — even with no physical presence.
 * This module evaluates a business's sales-by-state against those thresholds and
 * flags where it has met, or is approaching, nexus, so the filer knows where to
 * register (a tax_registration) before it is late.
 *
 * The evaluator is pure (no I/O) and fully unit-tested; the ledger aggregation
 * lives in the DB wrapper (us-nexus-ledger.ts). Sales figures are money strings
 * and the met/not-met decision uses exact comparison — a JS number would be
 * exact at these dollar scales, but the ledger already holds numeric(19,4) and
 * converting it just to compare would be a second, lossy representation.
 *
 * Thresholds are maintained REFERENCE DATA (as of 2026-01-01). States revise them
 * — several have dropped the 200-transaction test entirely — so the set below is
 * a documented starting point to verify per state, not legal advice.
 */

import { cmp, toUnits } from './money.ts'

export type NexusMeasure = 'sales_only' | 'sales_or_txn' | 'sales_and_txn'

export interface StateNexusThreshold {
  state: string
  salesUsd: number
  /** null when the state has no transaction-count trigger. */
  txnCount: number | null
  measure: NexusMeasure
}

/** The prevailing pattern: $100k in sales OR 200 separate transactions. */
export const US_NEXUS_DEFAULT: Omit<StateNexusThreshold, 'state'> = {
  salesUsd: 100_000,
  txnCount: 200,
  measure: 'sales_or_txn',
}

/** States whose threshold differs from the default. Verify before relying on it. */
export const US_NEXUS_OVERRIDES: Record<string, Omit<StateNexusThreshold, 'state'>> = {
  CA: { salesUsd: 500_000, txnCount: null, measure: 'sales_only' },
  TX: { salesUsd: 500_000, txnCount: null, measure: 'sales_only' },
  NY: { salesUsd: 500_000, txnCount: 100, measure: 'sales_and_txn' },
  // Notable states that dropped the transaction-count trigger (sales-only):
  TN: { salesUsd: 100_000, txnCount: null, measure: 'sales_only' },
  WI: { salesUsd: 100_000, txnCount: null, measure: 'sales_only' },
  WA: { salesUsd: 100_000, txnCount: null, measure: 'sales_only' },
  CO: { salesUsd: 100_000, txnCount: null, measure: 'sales_only' },
  IA: { salesUsd: 100_000, txnCount: null, measure: 'sales_only' },
  ND: { salesUsd: 100_000, txnCount: null, measure: 'sales_only' },
  NJ: { salesUsd: 100_000, txnCount: 200, measure: 'sales_or_txn' },
}

export function thresholdForState(state: string): StateNexusThreshold {
  const over = US_NEXUS_OVERRIDES[state]
  return { state, ...(over ?? US_NEXUS_DEFAULT) }
}

export interface StateSales {
  state: string
  /** Posted sales converted to USD, numeric(19,4) string. */
  salesUsd: string
  txnCount: number
}

export type NexusStatus = 'none' | 'approaching' | 'met'

export interface NexusEvaluation {
  state: string
  salesUsd: string
  txnCount: number
  threshold: StateNexusThreshold
  status: NexusStatus
  /** 0..1+ progress toward the binding trigger, for a UI meter. */
  progress: number
}

/** Whether the state's threshold is met by these figures. */
function isMet(t: StateNexusThreshold, salesUsd: string, txnCount: number): boolean {
  const salesMet = cmp(salesUsd, String(t.salesUsd)) >= 0
  const txnMet = t.txnCount != null && txnCount >= t.txnCount
  if (t.measure === 'sales_only') return salesMet
  if (t.measure === 'sales_and_txn') return salesMet && (t.txnCount == null ? true : txnMet)
  return salesMet || txnMet // sales_or_txn
}

/** Progress toward the binding trigger (max for OR, min for AND, sales for ONLY). */
function progressOf(t: StateNexusThreshold, salesUsd: string, txnCount: number): number {
  // The meter is UI. The status decision above is exact.
  const salesPct = t.salesUsd > 0 ? Number(toUnits(salesUsd)) / Number(toUnits(String(t.salesUsd))) : 0
  const txnPct = t.txnCount && t.txnCount > 0 ? txnCount / t.txnCount : 0
  if (t.measure === 'sales_only' || t.txnCount == null) return salesPct
  if (t.measure === 'sales_and_txn') return Math.min(salesPct, txnPct)
  return Math.max(salesPct, txnPct)
}

/**
 * Evaluate nexus for each state in `sales`. A state is `met` when its trigger is
 * satisfied, `approaching` when progress ≥ `approachingAt` (default 0.8) but not
 * yet met, else `none`. Sorted most-urgent first (met, then closest approaching).
 */
export function evaluateUsNexus(sales: StateSales[], opts?: { approachingAt?: number }): NexusEvaluation[] {
  const approachingAt = opts?.approachingAt ?? 0.8
  const out = sales.map((s): NexusEvaluation => {
    const threshold = thresholdForState(s.state)
    const met = isMet(threshold, s.salesUsd, s.txnCount)
    const progress = progressOf(threshold, s.salesUsd, s.txnCount)
    const status: NexusStatus = met ? 'met' : progress >= approachingAt ? 'approaching' : 'none'
    return { state: s.state, salesUsd: s.salesUsd, txnCount: s.txnCount, threshold, status, progress }
  })
  const rank = { met: 0, approaching: 1, none: 2 } as const
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.progress - a.progress)
}
