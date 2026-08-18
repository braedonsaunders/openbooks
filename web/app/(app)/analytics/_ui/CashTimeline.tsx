'use client'

import { useState } from 'react'
import { ListOrdered } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { CategoryWeekly, WeekRow } from '../../../../lib/cash/core'
import { CashWeekFlyout } from './CashWeekFlyout'
import { useAnalyticsMoney } from './format'

/**
 * The weekly cash timeline — the cash cockpit's centerpiece. One click on a
 * week opens the per-transaction flyout directly (no expand step), landing on
 * the week's dominant side with the in/out tabs a click away inside. Columns
 * adapt: Other In/Out appear when recurring categories exist, Deferred + the
 * spill-past-horizon banner when AP capacity scheduling is on.
 */
export function CashTimeline({
  weeks,
  categories,
  weeklyCap,
  restrictToSafe,
  deferredBeyondHorizon,
  canPayRun = false,
  canCollectionRun = false,
}: {
  weeks: WeekRow[]
  categories: CategoryWeekly[]
  weeklyCap: number
  restrictToSafe: boolean
  deferredBeyondHorizon: number
  /** Forwarded to the week flyout's run-builder action bar. */
  canPayRun?: boolean
  canCollectionRun?: boolean
}) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [flyout, setFlyout] = useState<{ week: WeekRow; side: 'ar' | 'ap' } | null>(null)
  const hasCats = categories.length > 0
  const scheduling = weeklyCap > 0 || restrictToSafe
  const open = (w: WeekRow) => {
    // Totals travel with the page; the transactions themselves are fetched by
    // the flyout for the week actually opened.
    setFlyout({ week: w, side: w.arTotal >= w.apTotal ? 'ar' : 'ap' })
  }

  return (
    <>
      {scheduling && deferredBeyondHorizon > 0 ? (
        <p className="flex items-start gap-2 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <ListOrdered size={14} className="mt-0.5 shrink-0" />
          <span><span className="font-semibold">{money(deferredBeyondHorizon)} of payables can&apos;t be paid within the horizon</span> under the current AP capacity settings — the backlog spills past the last week.</span>
        </p>
      ) : null}
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <th className="px-4 py-2 text-left font-medium">Week</th>
            <th className="px-3 py-2 text-right font-medium">Inflows</th>
            <th className="px-3 py-2 text-right font-medium">Outflows</th>
            {hasCats ? <th className="px-3 py-2 text-right font-medium">Other In</th> : null}
            {hasCats ? <th className="px-3 py-2 text-right font-medium">Other Out</th> : null}
            {scheduling ? <th className="px-3 py-2 text-right font-medium">Deferred</th> : null}
            <th className="px-3 py-2 text-right font-medium">Net</th>
            <th className="px-4 py-2 text-right font-medium">Ending Cash</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr
              key={w.weekStart}
              onClick={() => open(w)}
              className="cursor-pointer border-b border-slate-50 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30"
            >
              <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">
                {w.label}
                <span className="ml-2 text-[11px] font-normal text-slate-400 dark:text-slate-500">
                  {w.arCount + w.apCount > 0 ? `${w.arCount + w.apCount} txns` : ''}
                </span>
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{w.inflow > 0 ? money(w.inflow) : '—'}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">{w.outflow > 0 ? money(w.outflow) : '—'}</td>
              {hasCats ? <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600/80 dark:text-emerald-400/80">{w.dynamicInflow > 0 ? money(w.dynamicInflow) : '—'}</td> : null}
              {hasCats ? <td className="px-3 py-2.5 text-right tabular-nums text-red-600/80 dark:text-red-400/80">{w.dynamicOutflow > 0 ? money(w.dynamicOutflow) : '—'}</td> : null}
              {scheduling ? <td className="px-3 py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{w.deferredOut > 0 ? money(w.deferredOut) : '—'}</td> : null}
              <td className={cn('px-3 py-2.5 text-right font-medium tabular-nums', w.net >= 0 ? 'text-slate-800 dark:text-slate-200' : 'text-red-600 dark:text-red-400')}>{money(w.net)}</td>
              <td className={cn('px-4 py-2.5 text-right font-bold tabular-nums', w.endingCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{money(w.endingCash)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {flyout ? <CashWeekFlyout week={flyout.week} initialSide={flyout.side} categories={categories} weekIndex={weeks.indexOf(flyout.week)} canPayRun={canPayRun} canCollectionRun={canCollectionRun} onClose={() => setFlyout(null)} /> : null}
    </>
  )
}
