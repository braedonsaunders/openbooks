'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../reports/ReportTable"
import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ListOrdered } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { cmp as compareMoney } from '@openbooks/engine/src/money/money.ts'
import type { CategoryWeekly, WeekRow } from '../../../../lib/cash/core'
import { CashWeekFlyout } from './CashWeekFlyout'
import { useAnalyticsMoney } from './format'
import { InteractiveTableRow } from '@/components/interactive-table-row'

/**
 * The weekly cash timeline — the cash cockpit's centerpiece. One click on a
 * week opens the per-transaction flyout directly (no expand step), landing on
 * the week's dominant side with the in/out tabs a click away inside. Columns
 * adapt: Other In/Out appear when recurring categories exist, Deferred + the
 * spill-past-horizon banner when AP capacity scheduling is on.
 */
export function CashTimeline({
  weeks,
  selectedSubsidiaryIds,
  categories,
  weeklyCap,
  restrictToSafe,
  deferredBeyondHorizon,
  horizonWeeks,
  canPayRun = false,
  canCollectionRun = false,
}: {
  weeks: WeekRow[]
  selectedSubsidiaryIds?: string[]
  categories: CategoryWeekly[]
  weeklyCap: string
  restrictToSafe: boolean
  deferredBeyondHorizon: string
  /** Weeks rendered: forwarded to the week flyout so its drill names the
   * route's horizon instead of falling back to the 13-week default. */
  horizonWeeks?: number
  /** Forwarded to the week flyout's run-builder action bar. */
  canPayRun?: boolean
  canCollectionRun?: boolean
}) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: string) => fmtMoney(n, { compact: true })
  const t = useTranslations('banking.cash')
  const [flyout, setFlyout] = useState<{ week: WeekRow; side: 'ar' | 'ap' } | null>(null)
  const hasCats = categories.length > 0
  const scheduling = compareMoney(weeklyCap, '0.0000') > 0 || restrictToSafe
  const open = (w: WeekRow) => {
    // Totals travel with the page; the transactions themselves are fetched by
    // the flyout for the week actually opened.
    setFlyout({ week: w, side: compareMoney(w.arTotal, w.apTotal) >= 0 ? 'ar' : 'ap' })
  }

  return (
    <>
      {scheduling && compareMoney(deferredBeyondHorizon, '0.0000') > 0 ? (
        <p className="flex items-start gap-2 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <ListOrdered size={14} className="mt-0.5 shrink-0" />
          <span>{t.rich('timeline.spillBanner', { amount: money(deferredBeyondHorizon), strong: (chunks: ReactNode) => <span className="font-semibold">{chunks}</span> })}</span>
        </p>
      ) : null}
      <SharedTable className="w-full text-sm">
        <SharedTableHeader className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <SharedTableHead className="px-4 py-2 text-left font-medium">{t('cols.week')}</SharedTableHead>
            <SharedTableHead className="px-3 py-2 text-right font-medium">{t('cols.in')}</SharedTableHead>
            <SharedTableHead className="px-3 py-2 text-right font-medium">{t('cols.out')}</SharedTableHead>
            {hasCats ? <SharedTableHead className="px-3 py-2 text-right font-medium">{t('timeline.otherIn')}</SharedTableHead> : null}
            {hasCats ? <SharedTableHead className="px-3 py-2 text-right font-medium">{t('timeline.otherOut')}</SharedTableHead> : null}
            {scheduling ? <SharedTableHead className="px-3 py-2 text-right font-medium">{t('timeline.deferred')}</SharedTableHead> : null}
            <SharedTableHead className="px-3 py-2 text-right font-medium">{t('cols.net')}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-right font-medium">{t('cols.ending')}</SharedTableHead>
          </SharedTableRow>
        </SharedTableHeader>
        <SharedTableBody>
          {weeks.map((w) => (
            <InteractiveTableRow
              key={w.weekStart}
              onClick={() => open(w)}
              className="cursor-pointer border-b border-slate-50 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" noAnimate
            >
              <SharedTableCell className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">
                {w.label}
                <span className="ml-2 text-[11px] font-normal text-slate-400 dark:text-slate-500">
                  {w.arCount + w.apCount > 0 ? t('timeline.txns', { count: w.arCount + w.apCount }) : ''}
                </span>
              </SharedTableCell>
              <SharedTableCell className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{compareMoney(w.inflow, '0.0000') > 0 ? money(w.inflow) : '—'}</SharedTableCell>
              <SharedTableCell className="px-3 py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">{compareMoney(w.outflow, '0.0000') > 0 ? money(w.outflow) : '—'}</SharedTableCell>
              {hasCats ? <SharedTableCell className="px-3 py-2.5 text-right tabular-nums text-emerald-600/80 dark:text-emerald-400/80">{compareMoney(w.dynamicInflow, '0.0000') > 0 ? money(w.dynamicInflow) : '—'}</SharedTableCell> : null}
              {hasCats ? <SharedTableCell className="px-3 py-2.5 text-right tabular-nums text-red-600/80 dark:text-red-400/80">{compareMoney(w.dynamicOutflow, '0.0000') > 0 ? money(w.dynamicOutflow) : '—'}</SharedTableCell> : null}
              {scheduling ? <SharedTableCell className="px-3 py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{compareMoney(w.deferredOut, '0.0000') > 0 ? money(w.deferredOut) : '—'}</SharedTableCell> : null}
              <SharedTableCell className={cn('px-3 py-2.5 text-right font-medium tabular-nums', compareMoney(w.net, '0.0000') >= 0 ? 'text-slate-800 dark:text-slate-200' : 'text-red-600 dark:text-red-400')}>{money(w.net)}</SharedTableCell>
              <SharedTableCell className={cn('px-4 py-2.5 text-right font-bold tabular-nums', compareMoney(w.endingCash, '0.0000') < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{money(w.endingCash)}</SharedTableCell>
            </InteractiveTableRow>
          ))}
        </SharedTableBody>
      </SharedTable>

      {flyout ? <CashWeekFlyout week={flyout.week} initialSide={flyout.side} categories={categories} weekIndex={weeks.indexOf(flyout.week)} horizonWeeks={horizonWeeks} selectedSubsidiaryIds={selectedSubsidiaryIds} canPayRun={canPayRun} canCollectionRun={canCollectionRun} onClose={() => setFlyout(null)} /> : null}
    </>
  )
}
