import Link from 'next/link'
import { Badge, Button } from '@openbooks/ui'

/**
 * Composite cells for the bank account page.
 *
 * Each of these is a conditional pair the spec language must never express —
 * a value or a styled placeholder, a warning badge or a secondary one — so
 * the loader resolves plain strings and flags and the decision lives here,
 * in one implementation shared by the native page and the spec path.
 */

const STAT = 'rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900'
const STAT_LABEL = 'text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400'

export interface AccountStatsProps {
  glBalanceLabel: string
  glBalanceValue: string
  reconciledThroughLabel: string
  reconciledThrough: string | null
  neverLabel: string
  unmatchedLinesLabel: string
  unmatchedLinesValue: string
  reconciliationLabel: string
  reconBadgeLabel: string
  reconBadgeVariant: 'warning' | 'secondary'
}

/** The four header stat tiles: plain bordered divs, not cockpit tiles. */
export function AccountStats({
  glBalanceLabel,
  glBalanceValue,
  reconciledThroughLabel,
  reconciledThrough,
  neverLabel,
  unmatchedLinesLabel,
  unmatchedLinesValue,
  reconciliationLabel,
  reconBadgeLabel,
  reconBadgeVariant,
}: AccountStatsProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className={STAT}>
        <div className={STAT_LABEL}>{glBalanceLabel}</div>
        <div className="text-sm font-semibold tabular-nums">{glBalanceValue}</div>
      </div>
      <div className={STAT}>
        <div className={STAT_LABEL}>{reconciledThroughLabel}</div>
        <div className="text-sm font-semibold">
          {reconciledThrough ?? (
            <span className="font-normal text-slate-400 dark:text-slate-500">{neverLabel}</span>
          )}
        </div>
      </div>
      <div className={STAT}>
        <div className={STAT_LABEL}>{unmatchedLinesLabel}</div>
        <div className="text-sm font-semibold tabular-nums">{unmatchedLinesValue}</div>
      </div>
      <div className={STAT}>
        <div className={STAT_LABEL}>{reconciliationLabel}</div>
        <div className="text-sm font-semibold">
          <Badge variant={reconBadgeVariant}>{reconBadgeLabel}</Badge>
        </div>
      </div>
    </div>
  )
}

/** A statement's unmatched-line count: plain when nonzero, green zero when clean. */
export function UnmatchedCountCell({ display, isZero }: { display: string; isZero: boolean }) {
  if (isZero) return <span className="text-green-600 dark:text-green-400">0</span>
  return <>{display}</>
}

/** The reconcile workspace action: an outline small button wrapping a link. */
export function ReconActionCell({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={(href)}>{label}</Link>
    </Button>
  )
}
