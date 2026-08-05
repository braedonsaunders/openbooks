'use client'

import { useMoney } from '@/components/money-provider'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowRight, ShieldCheck, Gauge, TriangleAlert } from 'lucide-react'
import { Badge, Button, cn } from '@openbooks/ui'

export interface PlannerEntry {
  id: string
  docId: string | null
  docKind: string | null
  partyName: string
  amount: number
  dueDate: string | null
  daysOverdue: number
  method: string
}

export interface PayRunPlannerProps {
  recommended: PlannerEntry[]
  capacity: number | null
  startingCash: number
  restrictToSafe: boolean
  deferredThisWeek: number
}

const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * The AP pay-run planner: the capacity-scheduled recommendation for this week.
 * Bills are pre-selected; the user trims the set, watches the total against the
 * week's capacity, then hands the selection to the /payments run builder. The
 * selection RULE (cap + restrict-to-safe + recurring flows) is configured in
 * the cockpit's forecast-config flyout — see the gear on this panel.
 */
export function PayRunPlanner(props: PayRunPlannerProps) {
  const { money, moneyCompact } = useMoney()
  const t = useTranslations('ap.cockpit.payRun')
  const router = useRouter()
  const payable = useMemo(() => props.recommended.filter((e) => e.docId), [props.recommended])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(payable.map((e) => e.id)))

  const selectedEntries = payable.filter((e) => selected.has(e.id))
  const total = selectedEntries.reduce((a, e) => a + e.amount, 0)
  const cap = props.capacity
  const overCap = cap !== null && total > cap + 0.005
  const pct = cap && cap > 0 ? Math.min(100, (total / cap) * 100) : total > 0 ? 100 : 0

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const build = () => {
    const ids = selectedEntries.map((e) => e.docId!).filter(Boolean)
    if (!ids.length) return
    router.push(`/payments?view=runs&newRun=1&preselect=${ids.join(',')}` as any)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* capacity meter */}
      <div className="shrink-0 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 font-medium text-slate-500 dark:text-slate-400">
            {props.restrictToSafe ? <ShieldCheck size={13} /> : <Gauge size={13} />}
            {cap === null ? t('noCap') : props.restrictToSafe ? t('safeCapacity') : t('weeklyCap')}
          </span>
          <span className="tabular-nums text-slate-600 dark:text-slate-300">
            {money(total)}
            {cap !== null ? <span className="text-slate-400"> / {money(cap)}</span> : null}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className={cn('h-full rounded-full transition-all', overCap ? 'bg-red-500' : 'bg-teal-500')} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px]">
          <span className="text-slate-400 dark:text-slate-500">{t('startingCash', { amount: money(props.startingCash) })}</span>
          {overCap ? (
            <span className="flex items-center gap-1 font-medium text-red-600 dark:text-red-400"><TriangleAlert size={11} />{t('overCap')}</span>
          ) : props.deferredThisWeek > 0 ? (
            <span className="text-amber-600 dark:text-amber-400">{t('deferred', { amount: moneyCompact(props.deferredThisWeek) })}</span>
          ) : null}
        </div>
      </div>

      {/* recommended bills — fills the panel height, scrolls internally */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {payable.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {payable.map((e) => {
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
                    <td className="py-2 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{e.dueDate ? fmtDate(e.dueDate) : '—'}</td>
                    <td className="py-2 pr-4 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(e.amount)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* action bar */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
        <span className="text-xs text-slate-500 dark:text-slate-400">{t('selected', { count: selectedEntries.length })}</span>
        <Button size="sm" disabled={selectedEntries.length === 0} onClick={build}>
          {t('build')}
          <ArrowRight size={15} />
        </Button>
      </div>
    </div>
  )
}
