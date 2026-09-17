import { cmp as compareMoney, div as divideMoney, formatMoney, mulDecimal } from '@openbooks/engine/src/money.ts'

/**
 * Overdue share of open receivables as a bare whole-number percent string
 * ("100", never "100%"): the `ar.cockpit.stats.overdueSub` message template
 * already carries the percent sign ("{pct}% of open"), so a pre-suffixed
 * value renders the doubled "100%%" of F-t12-003. Exact-ledger-string math
 * throughout — no Number hop.
 */
export function overdueOpenPct(overdue: string, outstanding: string): string {
  if (compareMoney(outstanding, '0.0000') <= 0) return '0'
  return formatMoney(mulDecimal(divideMoney(overdue, outstanding), '100'), 0)
}
