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

import { cmp, toUnits } from '../money/money.ts'

export type NexusMeasure = 'none' | 'sales_only' | 'sales_or_txn' | 'sales_and_txn'

/**
 * Statutory measurement pattern for economic-nexus thresholds: the trailing
 * N months ending at the as-of date (the prevailing rule — e.g. Missouri
 * directs remote sellers to check the preceding 12-month receipts at each
 * quarter end). Thresholds are evaluated over this window, never over an
 * arbitrary display period. A state with a different statutory window needs
 * a per-state entry here, not a caller-supplied date range.
 */
export const US_NEXUS_MEASUREMENT_MONTHS = 12

export interface StateNexusThreshold {
  state: string
  /** Exact decimal string (whole USD for the statutory reference table; the working-currency translation of an entity ledger). Never a Number. */
  salesUsd: string
  /** null when the state has no transaction-count trigger. */
  txnCount: number | null
  measure: NexusMeasure
}

/** The prevailing pattern: $100k in sales OR 200 separate transactions. */
export const US_NEXUS_DEFAULT: Omit<StateNexusThreshold, 'state'> = {
  salesUsd: '100000',
  txnCount: 200,
  measure: 'sales_or_txn',
}

/**
 * States with no general statewide sales or use tax. Alaska is intentionally
 * omitted because local jurisdictions still impose sales tax there.
 */
const US_NEXUS_NO_STATEWIDE_SALES_TAX = new Set(['DE', 'MT', 'NH', 'OR'])

/** No state-level sales-tax nexus trigger applies in these states. */
const US_NEXUS_NOT_APPLICABLE: Omit<StateNexusThreshold, 'state'> = {
  salesUsd: '0',
  txnCount: null,
  measure: 'none',
}

/** States whose threshold differs from the default. Verify before relying on it. */
export const US_NEXUS_OVERRIDES: Record<string, Omit<StateNexusThreshold, 'state'>> = {
  CA: { salesUsd: '500000', txnCount: null, measure: 'sales_only' },
  TX: { salesUsd: '500000', txnCount: null, measure: 'sales_only' },
  NY: { salesUsd: '500000', txnCount: 100, measure: 'sales_and_txn' },
  // Notable states that dropped the transaction-count trigger (sales-only):
  // IN: S.B. 228 (2024), retroactive to 2024-01-01 — $100k gross revenue,
  // current or preceding calendar year, transaction test removed.
  IN: { salesUsd: '100000', txnCount: null, measure: 'sales_only' },
  // ME: LD 1216 (2021), effective 2022-01-01 — $100k gross sales, current
  // or previous calendar year, transaction test removed.
  ME: { salesUsd: '100000', txnCount: null, measure: 'sales_only' },
  TN: { salesUsd: '100000', txnCount: null, measure: 'sales_only' },
  WI: { salesUsd: '100000', txnCount: null, measure: 'sales_only' },
  WA: { salesUsd: '100000', txnCount: null, measure: 'sales_only' },
  CO: { salesUsd: '100000', txnCount: null, measure: 'sales_only' },
  IA: { salesUsd: '100000', txnCount: null, measure: 'sales_only' },
  ND: { salesUsd: '100000', txnCount: null, measure: 'sales_only' },
  NJ: { salesUsd: '100000', txnCount: 200, measure: 'sales_or_txn' },
  // Remote-seller $250k sales-only thresholds (I3-people-03): Alabama DOR
  // and Mississippi DOR apply $250,000 in retail sales with no transaction
  // trigger, so the generic $100k OR 200-transaction default over-applies.
  // Statutory measurement windows are separate per-state rules.
  AL: { salesUsd: '250000', txnCount: null, measure: 'sales_only' },
  MS: { salesUsd: '250000', txnCount: null, measure: 'sales_only' },
}

/**
 * Illinois removed its 200-transaction trigger effective 2026-01-01 (P.A.
 * 104-0006; IDOR Informational Bulletin FY 2026-12): from that date the only
 * threshold is $100,000 cumulative gross receipts, with the transaction test
 * applying only before. Jurisdiction rules are therefore effective-dated by
 * measurement-period end (`asOf`, an ISO date): periods ending before a change
 * keep the rule then in force, so history is never reinterpreted. Callers
 * without a period keep the timeless reference rule.
 */
const IL_TXN_REMOVED_ON = '2026-01-01'
const IL_SALES_ONLY: Omit<StateNexusThreshold, 'state'> = {
  salesUsd: '100000',
  txnCount: null,
  measure: 'sales_only',
}

export function thresholdForState(state: string, asOf?: string): StateNexusThreshold {
  if (US_NEXUS_NO_STATEWIDE_SALES_TAX.has(state)) {
    return { state, ...US_NEXUS_NOT_APPLICABLE }
  }
  if (state === 'IL' && (asOf ?? '') >= IL_TXN_REMOVED_ON) {
    return { state, ...IL_SALES_ONLY }
  }
  const over = US_NEXUS_OVERRIDES[state]
  return { state, ...(over ?? US_NEXUS_DEFAULT) }
}

export interface StateSales {
  state: string
  /**
   * Posted sales in the ledger's working currency: USD for the org-wide
   * ledger, or the filing entity's working currency for an entity ledger
   * (see computeUsNexusStatus `currency`). The name stays `salesUsd` so the
   * org-wide shape is byte-identical; read it as "sales in working currency".
   */
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
  if (t.measure === 'none') return false
  const salesMet = cmp(salesUsd, t.salesUsd) >= 0
  const txnMet = t.txnCount != null && txnCount >= t.txnCount
  if (t.measure === 'sales_only') return salesMet
  if (t.measure === 'sales_and_txn') return salesMet && (t.txnCount == null ? true : txnMet)
  return salesMet || txnMet // sales_or_txn
}

/** Progress toward the binding trigger (max for OR, min for AND, sales for ONLY). */
function progressOf(t: StateNexusThreshold, salesUsd: string, txnCount: number): number {
  // The meter is UI. The status decision above is exact.
  if (t.measure === 'none') return 0
  const salesPct = cmp(t.salesUsd, '0') > 0 ? Number(toUnits(salesUsd)) / Number(toUnits(t.salesUsd)) : 0
  const txnPct = t.txnCount && t.txnCount > 0 ? txnCount / t.txnCount : 0
  if (t.measure === 'sales_only' || t.txnCount == null) return salesPct
  if (t.measure === 'sales_and_txn') return Math.min(salesPct, txnPct)
  return Math.max(salesPct, txnPct)
}

/**
 * Evaluate nexus for each state in `sales`. A state is `met` when its trigger is
 * satisfied, `approaching` when progress ≥ `approachingAt` (default 0.8) but not
 * yet met, else `none`. Sorted most-urgent first (met, then closest approaching).
 * `thresholds` optionally overrides the reference threshold per state (an entity
 * ledger injects its policy-converted thresholds so the decision is exact in
 * the working currency).
 */
export function evaluateUsNexus(sales: StateSales[], opts?: { approachingAt?: number; thresholds?: ReadonlyMap<string, StateNexusThreshold>; asOf?: string }): NexusEvaluation[] {
  const approachingAt = opts?.approachingAt ?? 0.8
  const out = sales.map((s): NexusEvaluation => {
    // An entity ledger evaluates in a functional currency: it converts the
    // USD reference thresholds at its declared policy rate and injects them
    // here, so the comparison stays exact in the working currency while every
    // ledger figure remains a single conversion from posted evidence.
    const threshold = opts?.thresholds?.get(s.state) ?? thresholdForState(s.state, opts?.asOf)
    const met = isMet(threshold, s.salesUsd, s.txnCount)
    const progress = progressOf(threshold, s.salesUsd, s.txnCount)
    const status: NexusStatus = threshold.measure === 'none'
      ? 'none'
      : met ? 'met' : progress >= approachingAt ? 'approaching' : 'none'
    return { state: s.state, salesUsd: s.salesUsd, txnCount: s.txnCount, threshold, status, progress }
  })
  const rank = { met: 0, approaching: 1, none: 2 } as const
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.progress - a.progress)
}
