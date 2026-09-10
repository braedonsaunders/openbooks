import { Badge } from '@openbooks/ui'
import { DifferenceBadge } from './DifferenceBadge'

/**
 * Composite header pieces for the reconciliation session page.
 *
 * Each of these is a conditional pair the spec language must never express —
 * a translated status label or a raw code, a green zero-difference badge or
 * an amber one — so the loader resolves plain strings and flags and the
 * decision lives here, in one implementation shared by the native page and
 * the spec path.
 */

const STAT = 'rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900'
const STAT_LABEL = 'text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400'

/** The status badge in the page-header actions slot. */
export function ReconcileStatusBadge({
  label,
  variant,
}: {
  label: string
  variant: 'success' | 'warning' | 'secondary'
}) {
  return <Badge variant={variant}>{label}</Badge>
}

export interface ReconcileStatsProps {
  statementBalanceLabel: string
  statementBalanceValue: string
  clearedBalanceLabel: string
  clearedBalanceValue: string
  differenceLabel: string
  difference: string
  differenceCurrency: string
  matchedLabel: string
  matchedValue: string
}

/** The four header stat tiles: plain bordered divs, not cockpit tiles. */
export function ReconcileStats({
  statementBalanceLabel,
  statementBalanceValue,
  clearedBalanceLabel,
  clearedBalanceValue,
  differenceLabel,
  difference,
  differenceCurrency,
  matchedLabel,
  matchedValue,
}: ReconcileStatsProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className={STAT}>
        <div className={STAT_LABEL}>{statementBalanceLabel}</div>
        <div className="text-sm font-semibold tabular-nums">{statementBalanceValue}</div>
      </div>
      <div className={STAT}>
        <div className={STAT_LABEL}>{clearedBalanceLabel}</div>
        <div className="text-sm font-semibold tabular-nums">{clearedBalanceValue}</div>
      </div>
      <div className={STAT}>
        <div className={STAT_LABEL}>{differenceLabel}</div>
        <DifferenceBadge difference={difference} currency={differenceCurrency} />
      </div>
      <div className={STAT}>
        <div className={STAT_LABEL}>{matchedLabel}</div>
        <div className="text-sm font-semibold tabular-nums">{matchedValue}</div>
      </div>
    </div>
  )
}
