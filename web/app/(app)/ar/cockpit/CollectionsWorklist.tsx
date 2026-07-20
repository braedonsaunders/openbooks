'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowRight, TriangleAlert, CalendarClock } from 'lucide-react'
import { Badge, Button, cn } from '@openbooks/ui'
import { money } from '../../../../lib/format'
import { compactMoney } from '../../../../components/cockpit/ui'

export interface WorklistEntry {
  id: string
  docId: string | null
  docKind: string | null
  partyName: string
  amount: number
  dueDate: string | null
  predictedDate: string
  daysOverdue: number
  method: string
}

const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * The AR collections worklist — the pay-run planner's mirror. Every scheduled
 * receivable in the horizon, most overdue first; the overdue ones come
 * pre-checked (that's the chase list). The selection hands off to the
 * /receipts collection-run builder, which owns the funding account and
 * mandate mechanics.
 */
export function CollectionsWorklist({
  entries,
  overdueTotal,
  expectedThisWeek,
  canCollect,
}: {
  entries: WorklistEntry[]
  overdueTotal: number
  expectedThisWeek: number
  /** ar.pay — gates the collection-run handoff. */
  canCollect: boolean
}) {
  const t = useTranslations('ar.cockpit.worklist')
  const router = useRouter()
  // Only invoices with a source document can be routed into a collection run.
  const collectible = useMemo(() => entries.filter((e) => e.docId), [entries])
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(collectible.filter((e) => e.daysOverdue > 0).map((e) => e.id)),
  )

  const selectedEntries = collectible.filter((e) => selected.has(e.id))
  const total = selectedEntries.reduce((a, e) => a + e.amount, 0)

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const build = () => {
    const ids = selectedEntries.map((e) => e.docId!).filter(Boolean)
    if (!ids.length) return
    router.push(`/receipts?view=runs&newRun=1&preselect=${ids.join(',')}` as any)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* chase strip */}
      <div className="grid shrink-0 grid-cols-2 divide-x divide-slate-100 border-b border-slate-100 dark:divide-slate-800 dark:border-slate-800">
        <div className="px-4 py-2.5">
          <p className="flex items-center gap-1 text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
            <TriangleAlert size={11} /> {t('overdueToChase')}
          </p>
          <p className={cn('text-lg font-bold tabular-nums', overdueTotal > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{compactMoney(overdueTotal)}</p>
        </div>
        <div className="px-4 py-2.5">
          <p className="flex items-center gap-1 text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
            <CalendarClock size={11} /> {t('expectedThisWeek')}
          </p>
          <p className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{compactMoney(expectedThisWeek)}</p>
        </div>
      </div>

      {/* worklist — fills the panel height, scrolls internally */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {collectible.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="w-9 py-2 pl-4" />
                <th className="py-2 text-left font-medium">{t('customer')}</th>
                <th className="py-2 text-left font-medium">{t('prediction')}</th>
                <th className="py-2 text-right font-medium">{t('due')}</th>
                <th className="py-2 pr-4 text-right font-medium">{t('amount')}</th>
              </tr>
            </thead>
            <tbody>
              {collectible.map((e) => {
                const on = selected.has(e.id)
                return (
                  <tr
                    key={e.id}
                    className="group cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30"
                    onClick={() => toggle(e.id)}
                  >
                    <td className="w-9 py-2 pl-4">
                      <input type="checkbox" readOnly checked={on} className="h-4 w-4 accent-teal-600" aria-label={e.partyName} />
                    </td>
                    <td className="py-2">
                      <span className="font-medium text-slate-700 dark:text-slate-200">{e.partyName}</span>
                      {e.daysOverdue > 0 ? <Badge variant="warning" className="ml-1.5 text-[10px]">{e.daysOverdue}d</Badge> : null}
                    </td>
                    <td className="py-2 text-xs text-slate-500 dark:text-slate-400">{e.method}</td>
                    <td className="py-2 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{e.dueDate ? fmtDate(e.dueDate) : '—'}</td>
                    <td className="py-2 pr-4 text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">{money(e.amount)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* action bar */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
        <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{t('selected', { count: selectedEntries.length, amount: money(total) })}</span>
        {canCollect ? (
          <Button size="sm" disabled={selectedEntries.length === 0} onClick={build}>
            {t('build')}
            <ArrowRight size={15} />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
