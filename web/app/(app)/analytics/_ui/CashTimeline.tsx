'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, ListOrdered } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { CategoryWeekly, WeekRow } from '../../../../lib/cash/core'
import { CashWeekFlyout, type CategoryFlow } from './CashWeekFlyout'
import { fmtMoney } from './format'

const money = (n: number) => fmtMoney(n, { compact: true })

/**
 * Full-fidelity weekly cash timeline — the interactive table from the Gantry
 * cashflow port, extracted verbatim so nothing is lost in the move from the
 * analytics page to the Cash cockpit: expandable weeks with AR/AP/category
 * chips, Other In/Out columns when categories exist, the Deferred column and
 * AP-capacity chip when scheduling is on, the spill-past-horizon banner, and
 * the per-transaction flyout with entity reliability drill.
 */
export function CashTimeline({
  weeks,
  categories,
  weeklyCap,
  restrictToSafe,
  deferredBeyondHorizon,
}: {
  weeks: WeekRow[]
  categories: CategoryWeekly[]
  weeklyCap: number
  restrictToSafe: boolean
  deferredBeyondHorizon: number
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [flyout, setFlyout] = useState<{ week: WeekRow; side: 'ar' | 'ap' } | null>(null)
  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n })
  const hasCats = categories.length > 0
  const scheduling = weeklyCap > 0 || restrictToSafe
  const cols = 6 + (hasCats ? 2 : 0) + (scheduling ? 1 : 0)
  const catFlowsFor = (w: WeekRow): CategoryFlow[] => {
    const wi = weeks.indexOf(w)
    return categories
      .map((c) => ({ name: c.name, direction: c.direction, amount: c.weekly[wi] ?? 0 }))
      .filter((c) => c.amount > 0)
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
            <th className="w-8 px-2 py-2" />
            <th className="px-3 py-2 text-left font-medium">Week</th>
            <th className="px-3 py-2 text-right font-medium">Inflows</th>
            <th className="px-3 py-2 text-right font-medium">Outflows</th>
            {hasCats ? <th className="px-3 py-2 text-right font-medium">Other In</th> : null}
            {hasCats ? <th className="px-3 py-2 text-right font-medium">Other Out</th> : null}
            {scheduling ? <th className="px-3 py-2 text-right font-medium">Deferred</th> : null}
            <th className="px-3 py-2 text-right font-medium">Net</th>
            <th className="px-3 py-2 text-right font-medium">Ending Cash</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => {
            const isOpen = open.has(w.weekStart)
            return (
              <FragmentRows key={w.weekStart}>
                <tr className="cursor-pointer border-b border-slate-50 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" onClick={() => toggle(w.weekStart)}>
                  <td className="px-2 py-2.5 text-center text-slate-400">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                  <td className="px-3 py-2.5 font-medium text-slate-800 dark:text-slate-200">{w.label}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{w.inflow > 0 ? money(w.inflow) : '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">{w.outflow > 0 ? money(w.outflow) : '—'}</td>
                  {hasCats ? <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600/80 dark:text-emerald-400/80">{w.dynamicInflow > 0 ? money(w.dynamicInflow) : '—'}</td> : null}
                  {hasCats ? <td className="px-3 py-2.5 text-right tabular-nums text-red-600/80 dark:text-red-400/80">{w.dynamicOutflow > 0 ? money(w.dynamicOutflow) : '—'}</td> : null}
                  {scheduling ? <td className="px-3 py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{w.deferredOut > 0 ? money(w.deferredOut) : '—'}</td> : null}
                  <td className={cn('px-3 py-2.5 text-right font-medium tabular-nums', w.net >= 0 ? 'text-slate-800 dark:text-slate-200' : 'text-red-600 dark:text-red-400')}>{money(w.net)}</td>
                  <td className={cn('px-3 py-2.5 text-right font-bold tabular-nums', w.endingCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{money(w.endingCash)}</td>
                </tr>
                {isOpen ? (
                  <tr className="bg-slate-50/40 dark:bg-slate-800/20">
                    <td />
                    <td colSpan={cols - 1} className="px-3 py-2">
                      <div className="flex flex-wrap gap-2 text-xs">
                        <button type="button" onClick={() => setFlyout({ week: w, side: 'ar' })} className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 font-medium text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
                          {w.arEntries.length} AR inflows · {money(w.arEntries.reduce((a, e) => a + e.amount, 0))}
                        </button>
                        <button type="button" onClick={() => setFlyout({ week: w, side: 'ap' })} className="rounded-md border border-red-200 bg-red-50 px-2 py-1 font-medium text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                          {w.apEntries.length} AP outflows · {money(w.apEntries.reduce((a, e) => a + e.amount, 0))}
                        </button>
                        {categories.filter((c) => (c.weekly[weeks.indexOf(w)] ?? 0) > 0).map((c) => (
                          <span key={c.id} className={cn('rounded-md border px-2 py-1 font-medium', c.direction === 'inflow' ? 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900/50 dark:bg-teal-950/30 dark:text-teal-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300')}>
                            {c.name} · {money(c.weekly[weeks.indexOf(w)] ?? 0)}
                          </span>
                        ))}
                        {w.apCapacity !== null ? <span className="rounded-md border border-slate-200 px-2 py-1 text-slate-500 dark:border-slate-700 dark:text-slate-400">AP capacity {money(w.apCapacity)}</span> : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </FragmentRows>
            )
          })}
        </tbody>
      </table>

      {flyout ? <CashWeekFlyout week={flyout.week} initialSide={flyout.side} categoryFlows={catFlowsFor(flyout.week)} onClose={() => setFlyout(null)} /> : null}
    </>
  )
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
